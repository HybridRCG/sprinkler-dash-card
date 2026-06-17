const CARD_VERSION = 7;
const MAX_ZONES = 12;
const DEFAULT_META_SLOTS = [
  { label:'Rain last 24h', icon:'weather-rainy',      sensor1:'sensor.gw2000a_v2_1_8_event_rain_rate_piezo', sensor2:'',                                    enabled:true },
  { label:'Jojo Level',    icon:'water-well',         sensor1:'sensor.jojo_liters_left',                     sensor2:'sensor.jojo_tank_level_liquid_level', enabled:true },
  { label:'Weather',       icon:'weather-partly-cloudy', sensor1:'weather.met_office_pretoria',              sensor2:'',                                    enabled:true },
  { label:'Rain Predict',  icon:'cloud-question',     sensor1:'sensor.rain_status',                          sensor2:'sensor.rain_prediction_confidence',   enabled:true },
];
const DEFAULT_CONFIG = {
  zones: [
    { name:'Agter',        sw:'switch.sonoff_1001e74824_3', dur:'input_number.valve_1_time',  schedule_enabled:true },
    { name:'Visitor',      sw:'switch.sonoff_1001e74824_2', dur:'input_number.valve_2_time',  schedule_enabled:true },
    { name:'Jojo',         sw:'switch.sonoff_1001e74824_1', dur:'input_number.valve_3_time',  schedule_enabled:true },
    { name:'Gras Voor',    sw:'switch.sonoff_1001e74905_1', dur:'input_number.valve_4_time',  schedule_enabled:true },
    { name:'Gras Muur',    sw:'switch.sonoff_1001e74905_2', dur:'input_number.valve_5_time',  schedule_enabled:true },
    { name:'Gras Huis',    sw:'switch.sonoff_1001e74905_3', dur:'input_number.valve_6_time',  schedule_enabled:true },
    { name:'Visitor Voor', sw:'switch.sonoff_100230849a_1', dur:'input_number.valve_7_time',  schedule_enabled:true },
    { name:'Blombak',      sw:'switch.sonoff_1001e74824_4', dur:'input_number.valve_8_time',  schedule_enabled:true },
    { name:'Zone 9',       sw:'', dur:'',  schedule_enabled:true },
    { name:'Zone 10',      sw:'', dur:'',  schedule_enabled:true },
    { name:'Zone 11',      sw:'', dur:'',  schedule_enabled:true },
    { name:'Zone 12',      sw:'', dur:'',  schedule_enabled:true },
  ],
  active_zones: 8,
  schedule_entity: 'switch.schedule_sprinkler_scheduler',
  rain_sensor: 'sensor.gw2000a_v2_1_8_event_rain_rate_piezo',
  weather_entity: 'weather.met_office_pretoria',
  nav_path: '/lovelace',
  jojo_sensor: 'sensor.jojo_liters_left',
  rain_threshold: 5,
  jojo_low_pct: 35,
  meta_slots: JSON.parse(JSON.stringify(DEFAULT_META_SLOTS)),
  rules: {
    rain_disable_schedule: true,
    jojo_shutoff_zones: true,
  },
  confirm_actions: true,
};

class SprinklerDashCardV2 extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode:'open' });
    this._cfg = null;
    this._hass = null;
    this._built = false;
    this._onTimes = {};
    this._prevDurVals = {};
    this._editingTime = false;
    this._showConfig = false;
    this._cfgDragSrc = null;
    this._tickInterval = null;
    this._days = ['mon','tue','wed','thu','fri','sat','sun'];
    this._dayLabels = ['Mo','Tu','We','Th','Fr','Sa','Su'];
    this._allEntities = [];
    this._mdiIcons = [];
    this._mdiLoaded = false;
    this._scriptChecked = false;
    this._pendingEdits = {};
    this._saveDebounce = null; // key: 'zone-N-name' etc, value: current typed value
  }

  setConfig(config) {
    console.log('[SprinklerCard] setConfig called, zones[0].name =', config?.zones?.[0]?.name, 'nav_path =', config?.nav_path);
    const prevActiveZones = this._cfg?.active_zones;
    // deep-clone EVERYTHING — HA passes frozen objects, we need mutable copies
    const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const incoming = JSON.parse(JSON.stringify(config));
    for (const key of Object.keys(incoming)) merged[key] = incoming[key];
    this._cfg = merged;
    if (!Array.isArray(this._cfg.zones)) this._cfg.zones = JSON.parse(JSON.stringify(DEFAULT_CONFIG.zones));
    while (this._cfg.zones.length < MAX_ZONES) {
      const n = this._cfg.zones.length + 1;
      this._cfg.zones.push({ name:'Zone '+n, sw:'', dur:'' });
    }
    this._cfg.active_zones = Math.min(MAX_ZONES, Math.max(1, this._cfg.active_zones || 8));
    if (!Array.isArray(this._cfg.meta_slots)||this._cfg.meta_slots.length<4) {
      this._cfg.meta_slots = JSON.parse(JSON.stringify(DEFAULT_META_SLOTS));
    }
    if (!this._cfg.rules) this._cfg.rules = { ...DEFAULT_CONFIG.rules };
    this._cfg.zones.forEach(z=>{ if (z.schedule_enabled===undefined) z.schedule_enabled=true; });

    // restore any in-flight user edits that HA's echo may have overwritten
    for (const key of Object.keys(this._pendingEdits||{})) {
      const m = key.match(/^zone-(\d+)-name$/);
      if (m) {
        const idx = parseInt(m[1]);
        if (this._cfg.zones[idx]) this._cfg.zones[idx].name = this._pendingEdits[key];
      }
      if (key==='nav_path') this._cfg.nav_path = this._pendingEdits[key];
    }

    if (!this._built) {
      // first time — full build happens in set hass
      return;
    }

    // only rebuild zone grid if active zone count changed
    if (this._cfg.active_zones !== prevActiveZones) {
      this._buildZoneGrid();
    }

    // update zone name spans in main grid (config panel inputs are live)
    this._activeZones().forEach((z, i) => {
      const span = this.shadowRoot.getElementById('zone-'+i)?.querySelector('.zname');
      if (span) span.textContent = z.name;
    });

    this._update();
  }

  connectedCallback() { this._tickInterval = setInterval(()=>this._tick(), 1000); }
  disconnectedCallback() { clearInterval(this._tickInterval); }

  set hass(hass) {
    this._hass = hass;
    if (this._allEntities.length === 0) this._allEntities = Object.keys(hass.states).sort();
    if (!this._mdiLoaded) this._loadMdiIcons();
    if (!this._built) { this._buildShell(); this._built=true; }
    this._ensureSprinklerScript();
    this._update();
  }

  _loadMdiIcons() {
    this._mdiLoaded = true; // prevent multiple fetches
    fetch('https://raw.githubusercontent.com/Templarian/MaterialDesign/master/meta.json')
      .then(r=>r.json())
      .then(data=>{ this._mdiIcons = data.map(i=>i.name); })
      .catch(()=>{ this._mdiIcons = []; });
  }

  _svc(domain, service, data) { this._hass.callService(domain, service, data); }
  _activeZones() { return this._cfg.zones.slice(0, this._cfg.active_zones); }

  _skipList() {
    const s = this._hass.states['input_text.sprinkler_skip_zones']?.state || '';
    return s.split(',').map(x=>x.trim()).filter(Boolean);
  }

  _isZoneSkipped(z) {
    if (!z.sw) return false;
    return this._skipList().includes(z.sw);
  }

  _toggleSkip(z) {
    const e = 'input_text.sprinkler_skip_zones';
    if (!this._hass.states[e]) {
      console.warn('[SprinklerCard] skip helper not ready yet');
      return;
    }
    const cur = this._skipList();
    const isSkipped = cur.includes(z.sw);
    const next = isSkipped ? cur.filter(x=>x!==z.sw) : [...cur, z.sw];
    this._svc('input_text','set_value',{entity_id:e, value: next.join(',')});
  }

  _saveConfig(patch) {
    for (const key of Object.keys(patch)) this._cfg[key] = patch[key];
    if (patch.zones !== undefined) {
      clearTimeout(this._scriptRebuildTimer);
      this._scriptRebuildTimer = setTimeout(() => this._createSprinklerScript(), 1500);
    }
    // debounced websocket save — coalesces rapid changes into one write
    clearTimeout(this._saveDebounce);
    this._saveDebounce = setTimeout(() => {
      this._saveViaWebsocket(JSON.parse(JSON.stringify(this._cfg)), null);
    }, 300);
  }

  // show confirmation dialog — returns promise resolving true/false
  _confirm(title, msg, okClass='confirm-btn--ok') {
    if (!this._cfg.confirm_actions) return Promise.resolve(true);
    const r = this.shadowRoot;
    r.getElementById('confirm-title').textContent = title;
    r.getElementById('confirm-msg').textContent = msg;
    const okBtn = r.getElementById('confirm-ok');
    okBtn.className = 'confirm-btn ' + okClass;
    r.getElementById('confirm-modal').classList.add('confirm-modal--open');
    return new Promise(resolve => {
      this._confirmResolve = resolve;
      const onOk = () => {
        r.getElementById('confirm-modal').classList.remove('confirm-modal--open');
        okBtn.removeEventListener('click', onOk);
        resolve(true);
      };
      okBtn.addEventListener('click', onOk);
    });
  }

  _allOff() {
    this._confirm('All Off', 'Turn off all zones immediately?', 'confirm-btn--danger').then(ok => {
      if (!ok) return;
      const switches = this._activeZones().map(z=>z.sw).filter(Boolean);
      if (switches.length) this._svc('switch','turn_off',{entity_id:switches});
      this._activeZones().forEach((_,i)=>{ delete this._onTimes[i]; this._renderProgress(i,false,0,0); });
    });
  }

  _startSchedule() {
    this._confirm('Start Schedule', 'Run all scheduled zones now?').then(ok => {
      if (!ok) return;
      if (!this._hass.states['script.sprinkler']) {
        this._createSprinklerScript().then(() => {
          setTimeout(() => this._svc('script','turn_on',{entity_id:'script.sprinkler'}), 1000);
        });
      } else {
        this._svc('script','turn_on',{entity_id:'script.sprinkler'});
      }
    });
  }

  _createSprinklerScript() {
    // Build a sequential script from the active zones that are schedule-enabled
    const zones = this._activeZones().filter(z => z.sw && z.schedule_enabled !== false);
    if (!zones.length) return Promise.resolve();

    const skipEntity = 'input_text.sprinkler_skip_zones';
    const hasSkipHelper = !!this._hass.states[skipEntity];

    const sequence = [];
    zones.forEach(z => {
      if (hasSkipHelper) {
        // if this zone is in the skip list: remove it from the list (self-clearing) and don't water
        // otherwise: run normally
        sequence.push({
          if: [{
            condition: 'template',
            value_template: `{{ '${z.sw}' in (states('${skipEntity}') | default('','')).split(',') }}`,
          }],
          then: [{
            action: 'input_text.set_value',
            target: { entity_id: skipEntity },
            data: {
              value: `{{ (states('${skipEntity}') | default('','')).split(',') | reject('eq','${z.sw}') | reject('eq','') | list | join(',') }}`,
            },
          }],
          else: [
            { action:'switch.turn_on', target:{ entity_id: z.sw } },
            { delay: { minutes: `{{ states('${z.dur}') | float(10) | int }}` } },
            { action:'switch.turn_off', target:{ entity_id: z.sw } },
          ],
        });
      } else {
        // skip helper not available yet — run normally
        sequence.push({ action:'switch.turn_on', target:{ entity_id: z.sw } });
        sequence.push({ delay: { minutes: `{{ states('${z.dur}') | float(10) | int }}` } });
        sequence.push({ action:'switch.turn_off', target:{ entity_id: z.sw } });
      }
    });

    return this._hass.callApi('POST', 'config/script/config/sprinkler', {
      alias: 'Sprinkler',
      icon: 'mdi:sprinkler-fire',
      mode: 'single',
      sequence: sequence,
    }).catch(err => console.warn('sprinkler-dash-card: could not create script.sprinkler', err));
  }

  _ensureSprinklerScript() {
    if (this._scriptChecked) return;
    this._scriptChecked = true;
    const needsScript = !this._hass.states['script.sprinkler'];
    const needsSched  = !Object.values(this._hass.states).some(s =>
      s.entity_id.startsWith('switch.schedule_') &&
      (s.attributes.entities||[]).includes('script.sprinkler')
    );
    const needsSkipHelper = !this._hass.states['input_text.sprinkler_skip_zones'];

    const afterHelper = (helperJustCreated) => {
      if (needsScript || helperJustCreated) {
        this._createSprinklerScript().then(() => {
          if (needsSched) setTimeout(() => this._createSchedulerEntity(), 1200);
        });
      } else if (needsSched) {
        this._createSchedulerEntity();
      }
    };

    if (needsSkipHelper) {
      // create helper, then wait briefly for HA state to propagate before building the script
      this._createSkipHelper().then(() => setTimeout(()=>afterHelper(true), 1000)).catch(() => setTimeout(()=>afterHelper(false), 1000));
    } else {
      afterHelper(false);
    }
  }

  async _createSkipHelper() {
    // create input_text.sprinkler_skip_zones via the direct websocket helper-creation command
    try {
      await this._hass.connection.sendMessagePromise({
        type: 'input_text/create',
        name: 'Sprinkler Skip Zones',
        max: 255,
        min: 0,
        mode: 'text',
        initial: '',
        icon: 'mdi:calendar-remove',
      });
      console.log('[SprinklerCard] created input_text.sprinkler_skip_zones');
    } catch(e) {
      console.warn('[SprinklerCard] could not auto-create skip helper — per-zone skip will be unavailable until input_text.sprinkler_skip_zones exists', e);
    }
  }

  _createSchedulerEntity() {
    // create a scheduler entity for script.sprinkler with sensible defaults
    this._svc('scheduler', 'add', {
      weekdays: ['mon','wed','fri'],
      timeslots: [{
        start: '06:00:00',
        actions: [{ service: 'script.turn_on', entity_id: 'script.sprinkler' }],
      }],
      name: 'Sprinkler Scheduler',
    });
  }

  _buildShell() {
    this.shadowRoot.innerHTML = `<style>${this._css()}</style><ha-card id="root"></ha-card>`;
    this.shadowRoot.getElementById('root').innerHTML = this._mainHtml();
    this._bindMain();
    this._buildZoneGrid();
  }

  _css() { return `
    :host{display:block;font-family:var(--primary-font-family,sans-serif)}
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    ha-card{background:var(--card-background-color,#1c1c1c);border-radius:12px;overflow:hidden;border:1px solid var(--divider-color,rgba(255,255,255,0.08));box-shadow:var(--ha-card-box-shadow,none)}
    .hdr{background:linear-gradient(135deg,#0a5c45 0%,#1a8a64 55%,#4dc49a 100%);padding:10px 12px}
    .hdr-row1{display:flex;align-items:center;gap:8px;margin-bottom:5px}
    .hdr-title{display:flex;align-items:center;gap:7px;cursor:pointer;flex:1;min-width:0}
    .hdr-title h2{margin:0;font-size:17px;font-weight:600;color:#fff;white-space:nowrap}
    .hdr-title:hover h2{text-decoration:underline;text-underline-offset:2px}
    .badge{background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);border-radius:20px;padding:2px 10px;font-size:12px;color:rgba(255,255,255,0.9);white-space:nowrap;flex-shrink:0}
    .badge--active{background:rgba(255,220,80,0.25);border-color:rgba(255,220,80,0.5);color:#ffe566}
    .cfg-btn{background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);border-radius:6px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:rgba(255,255,255,0.8);flex-shrink:0;transition:background .15s}
    .cfg-btn:hover,.cfg-btn--active{background:rgba(255,255,255,0.25);border-color:rgba(255,255,255,0.5)}
    .hdr-meta{display:grid;gap:5px 8px;margin-bottom:8px;min-height:0}
    .hdr-meta--1{grid-template-columns:1fr}
    .hdr-meta--2{grid-template-columns:1fr 1fr}
    .hdr-meta--3{grid-template-columns:1fr 1fr 1fr}
    .hdr-meta--4{grid-template-columns:1fr 1fr}
    .hdr-meta--empty{display:none}
    .hdr-meta-item{display:flex;align-items:center;gap:4px;font-size:12px;font-weight:500;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;background:rgba(0,0,0,0.18);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:3px 7px;cursor:pointer;transition:background .15s}
    .hdr-meta-item:hover{background:rgba(0,0,0,0.32);border-color:rgba(255,255,255,0.25)}
    .hdr-btns{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    .hbtn{display:flex;align-items:center;justify-content:center;gap:5px;padding:8px 10px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:opacity .15s,transform .1s}
    .hbtn:active{transform:scale(0.97);opacity:.8}
    .hbtn--stop{background:rgba(210,45,45,0.9);color:#fff}
    .hbtn--start{background:rgba(255,255,255,0.92);color:#0a5c45}
    .zones{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:6px}
    .zone{border-radius:9px;border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.03);padding:8px 9px 7px;position:relative;overflow:hidden;transition:border-color .2s,background .2s}
    .zone::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:rgba(255,255,255,0.06);transition:background .2s}
    .zone--on{background:rgba(26,138,100,0.1);border-color:rgba(77,196,154,0.35)}
    .zone--on::before{background:linear-gradient(90deg,#1a8a64,#4dc49a)}
    .ztop{display:flex;align-items:center;gap:6px;margin-bottom:6px}
    .zseq{width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,0.06);color:var(--secondary-text-color,#555);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:1px solid rgba(255,255,255,0.08);transition:background .2s,color .2s}
    .zseq--on{background:rgba(26,138,100,0.4);color:#4dc49a;border-color:rgba(77,196,154,0.4)}
    .zname{flex:1;font-size:13px;font-weight:700;color:var(--primary-text-color,#f0f0f0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .zone--on .zname{color:#7de8c0}
    .zone--disabled .zname{color:var(--secondary-text-color,#555);text-decoration:line-through}
    .ztoggle{position:relative;width:32px;height:18px;border-radius:9px;background:rgba(255,255,255,0.12);cursor:pointer;flex-shrink:0;transition:background .25s}
    .ztoggle--on{background:#1a8a64}
    .ztoggle-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .25s;box-shadow:0 1px 3px rgba(0,0,0,0.4)}
    .ztoggle--on .ztoggle-thumb{transform:translateX(14px)}
    .zskip{width:20px;height:20px;border-radius:50%;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:var(--secondary-text-color,#666);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:all .15s;--mdc-icon-size:13px}
    .zskip:hover{border-color:rgba(255,180,60,0.5);color:#ffb43c}
    .zskip--active{background:rgba(255,180,60,0.18);border-color:rgba(255,180,60,0.5);color:#ffb43c}
    .zone--skip{border-color:rgba(255,180,60,0.4);border-style:dashed}
    .zone--skip::before{background:repeating-linear-gradient(90deg,#ffb43c 0 6px,transparent 6px 12px)!important}
    .zstat--skip{color:#ffb43c}
    .zprog-track{height:3px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;margin-bottom:4px}
    .zprog-fill{height:100%;width:0%;background:linear-gradient(90deg,#1a8a64,#4dc49a);border-radius:2px;transition:width .9s linear}
    .zstat{font-size:11px;color:var(--secondary-text-color,#666);display:flex;align-items:center;gap:4px;min-height:14px;margin-bottom:5px}
    .zstat--on{color:#4dc49a}
    .pulse{display:inline-block;width:5px;height:5px;border-radius:50%;background:#4dc49a;flex-shrink:0;animation:pulse 1.2s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(1.5)}}
    .zdivider{height:1px;background:rgba(255,255,255,0.05);margin-bottom:5px}
    .zdur-row{display:flex;align-items:center;gap:4px}
    .zdur-lbl{display:none}
    input[type=number].zdur-input{width:42px;padding:3px 4px;border-radius:5px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);color:var(--primary-text-color,#eee);font-size:12px;font-weight:600;text-align:center;-moz-appearance:textfield}
    input[type=number].zdur-input::-webkit-outer-spin-button,input[type=number].zdur-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
    input[type=number].zdur-input:focus{outline:none;border-color:#1a8a64;background:rgba(26,138,100,0.15)}
    .zdur-unit{font-size:11px;color:var(--secondary-text-color,#555);flex-shrink:0}
    .zdur-btns{display:flex;gap:3px;margin-left:auto}
    .zdur-btn{width:38px;height:20px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);color:var(--secondary-text-color,#aaa);font-size:15px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;transition:background .15s;padding:0}
    .zdur-btn:hover{background:rgba(26,138,100,0.35);border-color:#1a8a64;color:#4dc49a}
    .zdur-btn:active{transform:scale(0.93)}
    .sched-wrap{margin:0 6px 6px;border-radius:9px;border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.03);overflow:hidden}
    .sched-hdr{display:flex;align-items:center;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.05)}
    .sched-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--primary-text-color,#f0f0f0);flex:1}
    .stoggle{position:relative;width:32px;height:18px;border-radius:9px;background:rgba(255,255,255,0.12);cursor:pointer;flex-shrink:0;transition:background .25s}
    .stoggle--on{background:#1a8a64}
    .stoggle-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .25s;box-shadow:0 1px 3px rgba(0,0,0,0.4)}
    .stoggle--on .stoggle-thumb{transform:translateX(14px)}
    .sched-body{padding:8px 10px;display:flex;align-items:center;gap:8px}
    .sched-days{display:flex;gap:4px;flex:1;flex-wrap:wrap}
    .sday{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;cursor:pointer;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:var(--secondary-text-color,#666);transition:all .15s;flex-shrink:0;user-select:none}
    .sday--on{background:rgba(26,138,100,0.35);border-color:rgba(77,196,154,0.5);color:#4dc49a}
    .sched-time-wrap{display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0}
    .sched-time{font-size:20px;font-weight:700;color:var(--primary-text-color,#f0f0f0);cursor:pointer;letter-spacing:.02em;line-height:1;padding:2px 4px;border-radius:5px;border:1px solid transparent;transition:border-color .15s,background .15s;min-width:60px;text-align:right}
    .sched-time:hover{border-color:rgba(77,196,154,0.4);background:rgba(26,138,100,0.1)}
    .sched-time input[type=time]{width:74px;font-size:15px;font-weight:700;background:rgba(26,138,100,0.15);border:1px solid #1a8a64;border-radius:5px;color:var(--primary-text-color,#f0f0f0);padding:2px 4px;outline:none;text-align:center}
    .sched-next{font-size:11px;color:var(--secondary-text-color,#666)}
    .sched-next--on{color:#4dc49a}
    /* CONFIG PANEL — no overflow:hidden so dropdowns escape */
    .cfg-panel{display:none;border-top:1px solid rgba(255,255,255,0.06);flex-direction:column;max-height:70vh}
    .cfg-panel--open{display:flex}
    .cfg-sticky-hdr{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.1);flex-shrink:0;background:var(--card-background-color,#1c1c1c);position:sticky;top:0;z-index:10}
    .cfg-body{overflow-y:auto;flex:1}
    .cfg-section{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.05)}
    .cfg-section:last-child{border-bottom:none}
    .cfg-label{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--primary-text-color,#f0f0f0);margin-bottom:6px;font-weight:700}
    .cfg-zone-count{display:flex;align-items:center;gap:8px}
    .cfg-count-btn{width:28px;height:28px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);color:var(--primary-text-color,#ccc);font-size:17px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;transition:background .15s;flex-shrink:0}
    .cfg-count-btn:hover{background:rgba(26,138,100,0.3);border-color:#1a8a64;color:#4dc49a}
    .cfg-count-val{font-size:17px;font-weight:700;color:var(--primary-text-color,#eee);min-width:22px;text-align:center}
    .cfg-count-max{font-size:11px;color:var(--secondary-text-color,#666)}
    /* zone-disabled tick in grid */
    .zone--disabled{opacity:.55}
    .zone--disabled::before{background:rgba(255,255,255,0.04)!important}
    /* rules section */
    .rule-item{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:7px;border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.02);margin-bottom:4px}
    .rule-cb{width:16px;height:16px;accent-color:#1a8a64;cursor:pointer;flex-shrink:0;margin-top:2px}
    .rule-text{flex:1;min-width:0}
    .rule-title{font-size:12px;font-weight:600;color:var(--primary-text-color,#ddd);margin-bottom:2px}
    .rule-desc{font-size:10px;color:var(--secondary-text-color,#666);line-height:1.4}
    .rule-item--enabled .rule-title{color:#4dc49a}
    /* zone list — NO overflow hidden */
    .cfg-zone-list{display:flex;flex-direction:column;gap:0;margin-top:6px}
    .cfg-zone-item{border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.03);margin-bottom:4px;border-radius:7px;transition:border-color .15s;position:relative}
    .cfg-zone-item--inactive{opacity:.45}
    .cfg-zone-item--drag-over{border-color:rgba(77,196,154,0.6)!important;background:rgba(26,138,100,0.12)}
    .cfg-zone-item--dragging{opacity:.3}
    .cfg-zone-row1{display:flex;align-items:center;gap:5px;padding:6px 7px 3px}
    .cfg-zone-row2{display:flex;align-items:center;gap:5px;padding:0 7px 6px}
    .drag-handle{color:var(--secondary-text-color,#555);flex-shrink:0;font-size:14px;line-height:1;cursor:grab;user-select:none;padding:0 2px}
    .cfg-zone-seq{width:16px;height:16px;border-radius:50%;background:rgba(26,138,100,0.3);color:#4dc49a;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .cfg-zone-seq--inactive{background:rgba(255,255,255,0.06);color:var(--secondary-text-color,#555)}
    .cfg-zone-name{flex:1;min-width:0;padding:3px 6px;border-radius:5px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);color:var(--primary-text-color,#eee);font-size:11px;font-weight:600;outline:none}
    .cfg-zone-name:focus{border-color:#1a8a64;background:rgba(26,138,100,0.12)}
    .cfg-row2-lbl{font-size:9px;text-transform:uppercase;color:var(--secondary-text-color,#555);flex-shrink:0;width:100px;padding-left:4px}
    .cfg-zone-row2{display:flex;align-items:center;gap:5px;padding:0 7px 5px}
    /* entity search — z-index escape via fixed positioning */
    .es-wrap{position:relative;flex:1;min-width:0}
    .es-input{width:100%;padding:3px 6px;border-radius:5px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);color:var(--primary-text-color,#eee);font-size:10px;outline:none;font-family:monospace}
    .es-input:focus{border-color:#1a8a64;background:rgba(26,138,100,0.12)}
    .es-dropdown{position:fixed;z-index:9999;background:#1a1a1a;border:1px solid rgba(77,196,154,0.5);border-radius:7px;max-height:160px;overflow-y:auto;display:none;box-shadow:0 6px 20px rgba(0,0,0,0.7);min-width:200px}
    .es-dropdown--open{display:block}
    .es-opt{padding:5px 10px;font-size:10px;font-family:monospace;color:#ddd;cursor:pointer;transition:background .1s;white-space:nowrap}
    .es-opt:hover{background:rgba(26,138,100,0.3);color:#4dc49a}
    /* settings */
    .cfg-settings-list{display:flex;flex-direction:column;gap:5px;margin-top:4px}
    .cfg-slot-header{display:flex;align-items:center;gap:7px;margin-bottom:5px}
    .cfg-slot-cb{width:16px;height:16px;accent-color:#1a8a64;cursor:pointer;flex-shrink:0}
    .cfg-slot-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--secondary-text-color,#666);flex:1}
    .cfg-slot-title--enabled{color:#4dc49a}
    .icon-preview{width:24px;height:24px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.06);border-radius:5px;flex-shrink:0;--mdc-icon-size:14px}
    .icon-preview--set{background:rgba(26,138,100,0.2)}
    .cfg-field-row{display:flex;align-items:center;gap:6px}
    .cfg-field-lbl{font-size:10px;color:var(--secondary-text-color,#888);flex-shrink:0;width:72px}
    .cfg-field-input{flex:1;min-width:0;padding:4px 7px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);color:var(--primary-text-color,#eee);font-size:11px;outline:none}
    .cfg-field-input:focus{border-color:#1a8a64;background:rgba(26,138,100,0.12)}
    /* bottom buttons */
    .cfg-btns-row{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:10px 12px}
    .cfg-action-btn{padding:7px;border-radius:7px;border:none;font-size:11px;font-weight:600;cursor:pointer;transition:opacity .15s}
    .cfg-action-btn--close{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:var(--secondary-text-color,#999)}
    .cfg-action-btn--close:hover{background:rgba(255,255,255,0.1)}
    .cfg-action-btn--readme{background:rgba(26,138,100,0.2);border:1px solid rgba(77,196,154,0.3);color:#4dc49a}
    .cfg-action-btn--readme:hover{background:rgba(26,138,100,0.35)}
    .readme-modal{display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.75);align-items:center;justify-content:center;padding:16px}
    .readme-modal--open{display:flex}
    .readme-box{background:#1a1a1a;border:1px solid rgba(77,196,154,0.3);border-radius:12px;max-width:480px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden}
    .readme-sticky{padding:16px 20px 10px;border-bottom:1px solid rgba(77,196,154,0.15);flex-shrink:0}
    .readme-sticky h3{margin:0 0 10px;font-size:15px;color:#4dc49a;font-weight:700}
    .readme-btns{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    .readme-body{padding:4px 20px 16px;overflow-y:auto;flex:1}
    .readme-body h4{margin:12px 0 6px;font-size:12px;color:var(--primary-text-color,#eee);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
    .readme-body p,.readme-body li{font-size:12px;color:var(--secondary-text-color,#aaa);line-height:1.6;margin:3px 0}
    .readme-body ul{padding-left:16px;margin:4px 0}
    .readme-body code{background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;font-size:11px;font-family:monospace;color:#7de8c0}
    .readme-close{padding:8px;border-radius:7px;border:1px solid rgba(77,196,154,0.3);background:rgba(26,138,100,0.15);color:#4dc49a;font-size:12px;font-weight:600;cursor:pointer;width:100%}
    .readme-close:hover{background:rgba(26,138,100,0.3)}
    /* confirm modal */
    .confirm-modal{display:none;position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;padding:24px}
    .confirm-modal--open{display:flex}
    .confirm-box{background:#1a1a1a;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:20px;max-width:320px;width:100%;text-align:center}
    .confirm-box h4{margin:0 0 8px;font-size:15px;font-weight:600;color:var(--primary-text-color,#eee)}
    .confirm-box p{margin:0 0 16px;font-size:13px;color:var(--secondary-text-color,#aaa);line-height:1.5}
    .confirm-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .confirm-btn{padding:9px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}
    .confirm-btn--cancel{background:rgba(255,255,255,0.07);color:var(--secondary-text-color,#aaa);border:1px solid rgba(255,255,255,0.1)}
    .confirm-btn--cancel:hover{background:rgba(255,255,255,0.12)}
    .confirm-btn--ok{background:linear-gradient(135deg,#0a5c45,#1a8a64);color:#fff}
    .confirm-btn--ok:hover{opacity:.85}
    .confirm-btn--danger{background:rgba(210,45,45,0.85);color:#fff}
    .confirm-btn--danger:hover{opacity:.85}
  `; }

  _mainHtml() { return `
    <div class="hdr">
      <div class="hdr-row1">
        <div class="hdr-title" id="hdr-title">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2C9 7 5 10 5 14a7 7 0 0 0 14 0c0-4-4-7-7-12z"/><path d="M12 14v4M9 17h6"/></svg>
          <h2>Sprinklers</h2>
        </div>
        <span class="badge" id="hdr-badge">8 zones</span>
        <div class="cfg-btn" id="cfg-btn" title="Settings">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </div>
      </div>
      <div class="hdr-meta" id="hdr-meta"></div>
      <div class="hdr-btns">
        <button class="hbtn hbtn--stop" id="btn-off">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>All Off
        </button>
        <button class="hbtn hbtn--start" id="btn-start">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>Start Schedule
        </button>
      </div>
    </div>
    <div class="zones" id="zones"></div>
    <div class="sched-wrap">
      <div class="sched-hdr">
        <span class="sched-title">Schedule</span>
        <div class="stoggle" id="sched-toggle"><div class="stoggle-thumb"></div></div>
      </div>
      <div class="sched-body">
        <div class="sched-days" id="sched-days"></div>
        <div class="sched-time-wrap">
          <div class="sched-time" id="sched-time">--:--</div>
          <div class="sched-next" id="sched-next">—</div>
        </div>
      </div>
    </div>
    <div class="cfg-panel" id="cfg-panel"></div>
    <div class="readme-modal" id="readme-modal">
      <div class="readme-box">
        <div class="readme-sticky">
          <h3>💧 Sprinkler Card — Setup Guide</h3>
          <div class="readme-btns">
            <button class="readme-close" id="readme-close">Got it</button>
            <button class="readme-close" id="readme-copy" style="background:rgba(26,138,100,0.2);border-color:rgba(77,196,154,0.4)">📋 Copy</button>
          </div>
        </div>
        <div class="readme-body">
        <h4>Step 1 — Install the card</h4>
        <ul>
          <li>Copy <code>sprinkler-dash-card.js</code> to <code>/config/www/</code></li>
          <li>Go to <b>Settings → Dashboards → Resources</b></li>
          <li>Add <code>/local/sprinkler-dash-card.js</code> as type <b>JavaScript Module</b></li>
          <li>Add the card: <code>type: custom:sprinkler-dash-card-v2</code></li>
        </ul>

        <h4>Step 2 — Create duration helpers</h4>
        <p>Go to <b>Settings → Helpers → Add → Number</b> and create one per zone:</p>
        <ul>
          <li><code>input_number.valve_1_time</code> through <code>input_number.valve_8_time</code></li>
          <li>Settings: min 0, max 60, step 5, unit <b>min</b></li>
          <li>Add up to <code>valve_10_time</code> if using more than 8 zones</li>
        </ul>

        <h4>Step 3 — Install Scheduler integration</h4>
        <p>Install <b>Scheduler Component</b> via HACS (Integration category). That's all — the card automatically creates both <code>script.sprinkler</code> and the scheduler entity on first load. The scheduler defaults to Mon/Wed/Fri at 06:00 — adjust the days and time using the Schedule section on the card.</p>

        <h4>Step 4 — Configure zones in ⚙️</h4>
        <p>Tap the gear icon → <b>Active Zones</b> to set how many zones to show. For each zone set the <b>Switch Entity</b> (your valve switch) and <b>Duration Entity</b> (the input_number from Step 2). Use the search field to find entities. Drag <b>⠿</b> to reorder. Tick the checkbox to include a zone in the schedule.</p>

        <h4>Step 5 — Configure settings in ⚙️</h4>
        <ul>
          <li><b>Nav path</b>: where tapping the title navigates (e.g. <code>/lovelace</code>)</li>
          <li><b>Rain sensor</b>: precipitation sensor in mm</li>
          <li><b>Rain limit</b>: mm above which schedule auto-disables (turns yellow)</li>
          <li><b>Weather</b>: any <code>weather.*</code> entity</li>
          <li><b>Jojo sensor</b>: water tank litres entity</li>
          <li><b>Jojo low %</b>: tank level below which all zones shut off immediately (turns red)</li>
          <li><b>Schedule switch</b>: the <code>switch.schedule_*</code> entity from Scheduler</li>
        </ul>

        <h4>Step 6 — Configure info bar in ⚙️</h4>
        <p>4 slots are available. Each slot has an enable checkbox, label, MDI icon (searchable), and up to 2 sensors. Tap any info bar item to open the entity detail. Layout auto-adjusts: 1=full, 2=50/50, 3=3-col, 4=2×2.</p>

        <h4>Step 7 — Automation rules in ⚙️</h4>
        <p>Enable or disable the built-in rules at the bottom of settings: <b>Confirm before activating</b>, <b>Rain auto-disable</b>, and <b>Jojo low-level shutoff</b>. Each rule shows its current threshold.</p>

        <h4>Skip next run (per zone)</h4>
        <p>Tap the <b>calendar-remove</b> icon next to any zone name to mark it as skipped for the next run only. The zone gets an amber dashed border and shows "Skip next run". No confirmation needed — tap again to cancel. When the schedule (or Start Schedule) next runs, that zone is bypassed and the skip automatically clears itself — no setup required, the card creates a small helper for this on first load.</p>

        <h4>Schedule section</h4>
        <p>The toggle enables/disables the schedule. Tap day pills to toggle run days. Tap the time to edit it. The countdown shows when the schedule next fires.</p>
        </div>
      </div>
    </div>
    <div class="confirm-modal" id="confirm-modal">
      <div class="confirm-box">
        <h4 id="confirm-title">Are you sure?</h4>
        <p id="confirm-msg"></p>
        <div class="confirm-btns">
          <button class="confirm-btn confirm-btn--cancel" id="confirm-cancel">Cancel</button>
          <button class="confirm-btn confirm-btn--ok" id="confirm-ok">Confirm</button>
        </div>
      </div>
    </div>
  `; }

  _bindMain() {
    const r = this.shadowRoot;
    r.getElementById('hdr-title').addEventListener('click', () => {
      const p = this._cfg.nav_path;
      if (p) { window.history.pushState(null,'',p); window.dispatchEvent(new CustomEvent('location-changed',{bubbles:true,composed:true})); }
    });
    r.getElementById('cfg-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this._showConfig = !this._showConfig;
      r.getElementById('cfg-btn').classList.toggle('cfg-btn--active', this._showConfig);
      r.getElementById('cfg-panel').classList.toggle('cfg-panel--open', this._showConfig);
      if (this._showConfig) this._renderConfigPanel();
    });
    r.getElementById('btn-off').addEventListener('click', () => this._allOff());
    r.getElementById('btn-start').addEventListener('click', () => this._startSchedule());
    r.getElementById('sched-toggle').addEventListener('click', () => {
      const e = this._cfg.schedule_entity; if (!e) return;
      const isOn = this._hass.states[e]?.state==='on';
      const msg = isOn ? 'Disable the irrigation schedule?' : 'Enable the irrigation schedule?';
      const okClass = isOn ? 'confirm-btn--danger' : 'confirm-btn--ok';
      this._confirm('Schedule', msg, okClass).then(ok => {
        if (ok) this._svc('switch', isOn?'turn_off':'turn_on', {entity_id:e});
      });
    });
    const daysEl = r.getElementById('sched-days');
    this._days.forEach((d,i) => {
      const btn = document.createElement('div');
      btn.className='sday'; btn.id='sday-'+d; btn.textContent=this._dayLabels[i];
      btn.addEventListener('click', ()=>this._toggleDay(d));
      daysEl.appendChild(btn);
    });
    const timeEl = r.getElementById('sched-time');
    timeEl.addEventListener('click', () => {
      if (this._editingTime) return; this._editingTime=true;
      const cur = timeEl.textContent.trim();
      const inp = document.createElement('input'); inp.type='time'; inp.value=cur;
      timeEl.innerHTML=''; timeEl.appendChild(inp); inp.focus();
      const save = () => { this._editingTime=false; const val=inp.value; timeEl.textContent=val||cur; if (val&&val!==cur) this._saveTime(val); };
      inp.addEventListener('blur', save); inp.addEventListener('change', save);
    });
    r.getElementById('readme-close').addEventListener('click', () => {
      r.getElementById('readme-modal').classList.remove('readme-modal--open');
    });
    // confirm modal — cancel just closes
    r.getElementById('confirm-cancel').addEventListener('click', () => {
      r.getElementById('confirm-modal').classList.remove('confirm-modal--open');
      this._confirmResolve && this._confirmResolve(false);
    });
    r.getElementById('readme-copy').addEventListener('click', () => {
      const box = r.getElementById('readme-modal').querySelector('.readme-body');
      const text = box.innerText.replace(/Got it|Copy readme/g,'').trim();
      navigator.clipboard.writeText(text).then(() => {
        const btn = r.getElementById('readme-copy');
        const orig = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(()=>{ btn.textContent=orig; }, 1500);
      }).catch(()=>{});
    });
  }

  _buildZoneGrid() {
    const grid = this.shadowRoot.getElementById('zones'); if (!grid) return;
    grid.innerHTML='';
    this._activeZones().forEach((z,i) => {
      const el=document.createElement('div'); el.className='zone'+(z.schedule_enabled===false?' zone--disabled':''); el.id='zone-'+i;
      const top=document.createElement('div'); top.className='ztop';
      const seq=document.createElement('div'); seq.className='zseq'; seq.id='zseq-'+i; seq.textContent=i+1;
      const name=document.createElement('span'); name.className='zname'; name.textContent=z.name;
      const skip=document.createElement('div'); skip.className='zskip'; skip.id='zskip-'+i;
      skip.title='Skip next scheduled run';
      const skipIcon=document.createElement('ha-icon'); skipIcon.setAttribute('icon','mdi:calendar-remove'); skip.appendChild(skipIcon);
      const tog=document.createElement('div'); tog.className='ztoggle'; tog.id='ztog-'+i;
      tog.appendChild(Object.assign(document.createElement('div'),{className:'ztoggle-thumb'}));
      top.append(seq,name,skip,tog);
      const pt=document.createElement('div'); pt.className='zprog-track';
      const pf=document.createElement('div'); pf.className='zprog-fill'; pf.id='zprog-'+i; pt.appendChild(pf);
      const stat=document.createElement('div'); stat.className='zstat'; stat.id='zstat-'+i; stat.textContent='Ready';
      const dv=document.createElement('div'); dv.className='zdivider';
      const dr=document.createElement('div'); dr.className='zdur-row';
      const dl=document.createElement('span'); dl.className='zdur-lbl'; dl.textContent='Min';
      const di=document.createElement('input'); di.type='number'; di.className='zdur-input';
      di.id='zdur-'+i; di.min=0; di.max=60; di.step=5; di.value=10;
      const du=document.createElement('span'); du.className='zdur-unit'; du.textContent='min';
      const db=document.createElement('div'); db.className='zdur-btns';
      const bm=document.createElement('button'); bm.className='zdur-btn'; bm.textContent='-';
      const bp=document.createElement('button'); bp.className='zdur-btn'; bp.textContent='+';
      db.append(bm,bp); dr.append(dl,di,du,db);
      el.append(top,pt,stat,dv,dr); grid.appendChild(el);
      skip.addEventListener('click',()=>{
        if (!z.sw) return;
        this._toggleSkip(z);
      });
      tog.addEventListener('click',()=>{
        if (!z.sw) return;
        const isOn = this._hass.states[z.sw]?.state==='on';
        const action = isOn ? 'turn_off' : 'turn_on';
        const msg = isOn ? `Turn off ${z.name}?` : `Turn on ${z.name}?`;
        const okClass = isOn ? 'confirm-btn--danger' : 'confirm-btn--ok';
        this._confirm(z.name, msg, okClass).then(ok => {
          if (ok) this._svc('switch', action, {entity_id:z.sw});
        });
      });
      const applyDur=(val)=>{ val=Math.min(60,Math.max(0,val)); di.value=val; if(z.dur)this._svc('input_number','set_value',{entity_id:z.dur,value:val}); if(this._onTimes[i])this._onTimes[i].totalSecs=val*60; };
      di.addEventListener('change',()=>applyDur(parseFloat(di.value)||0));
      bm.addEventListener('click',()=>applyDur((parseFloat(di.value)||0)-5));
      bp.addEventListener('click',()=>applyDur((parseFloat(di.value)||0)+5));
    });
  }

  // entity search with fixed-position dropdown injected to document body
  _makeEntityInput(currentVal, onChange) {
    // ensure global styles exist (may already be injected by _makeIconInput)
    if (!document.getElementById('sdc-dropdown-style')) {
      const st = document.createElement('style'); st.id='sdc-dropdown-style';
      st.textContent = `
        .sdc-dropdown{position:fixed;z-index:99999;background:#1e1e1e;border:1px solid rgba(77,196,154,0.5);border-radius:7px;max-height:180px;overflow-y:auto;display:none;box-shadow:0 6px 24px rgba(0,0,0,0.8);min-width:220px}
        .sdc-dropdown.open{display:block}
        .sdc-opt{padding:6px 10px;font-size:11px;font-family:monospace;color:#ddd;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .sdc-opt:hover{background:rgba(26,138,100,0.35);color:#4dc49a}
        .sdc-icon-opt{display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;transition:background .1s}
        .sdc-icon-opt:hover{background:rgba(26,138,100,0.35)}
        .sdc-icon-opt span{font-size:11px;font-family:monospace;color:#ddd}
        .sdc-icon-opt ha-icon{--mdc-icon-size:16px;color:#4dc49a;flex-shrink:0}
      `;
      document.head.appendChild(st);
    }

    const wrap = document.createElement('div'); wrap.className='es-wrap';
    const inp = document.createElement('input'); inp.type='text'; inp.className='es-input';
    inp.value=currentVal; inp.placeholder='search entity...';
    wrap.appendChild(inp);

    const dd = document.createElement('div'); dd.className='sdc-dropdown';
    document.body.appendChild(dd);

    const position = () => {
      const r = inp.getBoundingClientRect();
      dd.style.top  = (r.bottom + 2)+'px';
      dd.style.left = r.left+'px';
      dd.style.width = Math.max(240, r.width)+'px';
    };

    let debounce;
    const show = (q) => {
      q = (q||'').toLowerCase().trim();
      dd.innerHTML='';
      if (!q) { dd.classList.remove('open'); return; }
      const hits = this._allEntities.filter(e=>e.includes(q)).slice(0,40);
      if (!hits.length) { dd.classList.remove('open'); return; }
      hits.forEach(e => {
        const opt=document.createElement('div'); opt.className='sdc-opt'; opt.textContent=e;
        opt.addEventListener('mousedown',(ev)=>{ ev.preventDefault(); inp.value=e; dd.classList.remove('open'); onChange(e); });
        dd.appendChild(opt);
      });
      position();
      dd.classList.add('open');
    };

    inp.addEventListener('input',()=>{ clearTimeout(debounce); debounce=setTimeout(()=>show(inp.value),80); });
    inp.addEventListener('focus',()=>{ show(inp.value); });
    inp.addEventListener('blur',()=>{ setTimeout(()=>dd.classList.remove('open'),250); onChange(inp.value.trim()); });
    inp.addEventListener('keydown',(e)=>{ if(e.key==='Escape'){dd.classList.remove('open');} });

    // cleanup on disconnect
    const obs = new MutationObserver(()=>{ if(!wrap.isConnected){ dd.remove(); obs.disconnect(); } });
    obs.observe(document.body,{childList:true,subtree:true});

    return wrap;
  }

  // MDI icon search input
  _makeIconInput(currentVal, previewEl, onChange) {
    if (!document.getElementById('sdc-dropdown-style')) {
      const st = document.createElement('style'); st.id='sdc-dropdown-style';
      st.textContent = `
        .sdc-dropdown{position:fixed;z-index:99999;background:#1e1e1e;border:1px solid rgba(77,196,154,0.5);border-radius:7px;max-height:180px;overflow-y:auto;display:none;box-shadow:0 6px 24px rgba(0,0,0,0.8);min-width:220px}
        .sdc-dropdown.open{display:block}
        .sdc-opt{padding:6px 10px;font-size:11px;font-family:monospace;color:#ddd;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .sdc-opt:hover{background:rgba(26,138,100,0.35);color:#4dc49a}
        .sdc-icon-opt{display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;transition:background .1s}
        .sdc-icon-opt:hover{background:rgba(26,138,100,0.35)}
        .sdc-icon-opt span{font-size:11px;font-family:monospace;color:#ddd}
        .sdc-icon-opt ha-icon{--mdc-icon-size:16px;color:#4dc49a;flex-shrink:0}
      `;
      document.head.appendChild(st);
    }

    const wrap = document.createElement('div'); wrap.className='es-wrap';
    const inp = document.createElement('input'); inp.type='text'; inp.className='es-input';
    inp.value=currentVal; inp.placeholder='search mdi icon...';
    wrap.appendChild(inp);

    const dd = document.createElement('div'); dd.className='sdc-dropdown';
    document.body.appendChild(dd);

    const position = () => {
      const r = inp.getBoundingClientRect();
      dd.style.top  = (r.bottom+2)+'px';
      dd.style.left = r.left+'px';
      dd.style.width = Math.max(240,r.width)+'px';
    };

    const updatePreview = (name) => {
      if (previewEl) {
        previewEl.innerHTML='';
        if (name) {
          previewEl.classList.add('icon-preview--set');
          const ic=document.createElement('ha-icon'); ic.setAttribute('icon','mdi:'+name);
          ic.style.cssText='--mdc-icon-size:14px;color:#4dc49a';
          previewEl.appendChild(ic);
        } else {
          previewEl.classList.remove('icon-preview--set');
        }
      }
    };

    let debounce;
    const show = (q) => {
      q=(q||'').toLowerCase().trim();
      dd.innerHTML='';
      if (!q) { dd.classList.remove('open'); return; }
      const src = this._mdiIcons.length ? this._mdiIcons : [];
      const hits = src.filter(n=>n.includes(q)).slice(0,40);
      if (!hits.length) { dd.classList.remove('open'); return; }
      hits.forEach(name=>{
        const opt=document.createElement('div'); opt.className='sdc-icon-opt';
        const ic=document.createElement('ha-icon'); ic.setAttribute('icon','mdi:'+name);
        const lbl=document.createElement('span'); lbl.textContent=name;
        opt.append(ic,lbl);
        opt.addEventListener('mousedown',(ev)=>{
          ev.preventDefault(); inp.value=name; dd.classList.remove('open');
          updatePreview(name); onChange(name);
        });
        dd.appendChild(opt);
      });
      position(); dd.classList.add('open');
    };

    inp.addEventListener('input',()=>{ clearTimeout(debounce); debounce=setTimeout(()=>show(inp.value),100); });
    inp.addEventListener('focus',()=>{ if(inp.value) show(inp.value); });
    inp.addEventListener('blur',()=>{ setTimeout(()=>dd.classList.remove('open'),250); onChange(inp.value.trim()); updatePreview(inp.value.trim()); });
    inp.addEventListener('keydown',(e)=>{ if(e.key==='Escape') dd.classList.remove('open'); });

    updatePreview(currentVal);

    const obs=new MutationObserver(()=>{ if(!wrap.isConnected){ dd.remove(); obs.disconnect(); } });
    obs.observe(document.body,{childList:true,subtree:true});

    return wrap;
  }

  _renderConfigPanel() {
    const panel = this.shadowRoot.getElementById('cfg-panel');
    panel.innerHTML='';

    // ── Sticky header ──
    const stickyHdr=document.createElement('div'); stickyHdr.className='cfg-sticky-hdr';

    const saveBtn=document.createElement('button');
    saveBtn.style.cssText='flex:1;padding:7px;border-radius:7px;border:none;background:linear-gradient(135deg,#0a5c45,#1a8a64);color:#fff;font-size:12px;font-weight:700;cursor:pointer';
    saveBtn.textContent='💾 Save';
    saveBtn.addEventListener('click',()=>this._doSave(saveBtn));

    const closeBtn=document.createElement('button'); closeBtn.className='cfg-action-btn cfg-action-btn--close';
    closeBtn.style.cssText='padding:7px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.06);color:var(--secondary-text-color,#999);font-size:12px;font-weight:600;cursor:pointer';
    closeBtn.textContent='Close';
    closeBtn.addEventListener('click',()=>{
      this._showConfig=false;
      this.shadowRoot.getElementById('cfg-btn').classList.remove('cfg-btn--active');
      panel.classList.remove('cfg-panel--open');
    });

    const readmeBtn=document.createElement('button'); readmeBtn.className='cfg-action-btn cfg-action-btn--readme';
    readmeBtn.style.cssText='padding:7px 12px;border-radius:7px;border:1px solid rgba(77,196,154,0.3);background:rgba(26,138,100,0.2);color:#4dc49a;font-size:12px;font-weight:600;cursor:pointer';
    readmeBtn.textContent='📖';
    readmeBtn.title='Setup Instructions';
    readmeBtn.addEventListener('click',()=>{
      this.shadowRoot.getElementById('readme-modal').classList.add('readme-modal--open');
    });

    stickyHdr.append(saveBtn, closeBtn, readmeBtn);
    panel.appendChild(stickyHdr);

    // ── Scrollable body ──
    const body=document.createElement('div'); body.className='cfg-body';
    panel.appendChild(body);

    // ── Zone list + active zone count on same header line ──
    const s2=document.createElement('div'); s2.className='cfg-section';
    const zoneHdr=document.createElement('div'); zoneHdr.style.cssText='display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const l2=document.createElement('div'); l2.className='cfg-label'; l2.style.margin='0'; l2.textContent='Zones — drag to reorder';
    const czrow=document.createElement('div'); czrow.className='cfg-zone-count'; czrow.style.cssText='display:flex;align-items:center;gap:6px';
    const bm=document.createElement('button'); bm.className='cfg-count-btn'; bm.textContent='-';
    const bp=document.createElement('button'); bp.className='cfg-count-btn'; bp.textContent='+';
    const cv=document.createElement('div'); cv.className='cfg-count-val'; cv.id='cfg-count-val'; cv.textContent=this._cfg.active_zones;
    const cm=document.createElement('span'); cm.className='cfg-count-max'; cm.textContent='/ '+MAX_ZONES;
    bm.addEventListener('click',()=>{
      const n=Math.max(1,this._cfg.active_zones-1);
      this._saveConfig({active_zones:n}); cv.textContent=n;
      this._buildZoneGrid(); this._update();
      this._renderConfigPanel();
    });
    bp.addEventListener('click',()=>{
      const n=Math.min(MAX_ZONES,this._cfg.active_zones+1);
      this._saveConfig({active_zones:n}); cv.textContent=n;
      this._buildZoneGrid(); this._update();
      this._renderConfigPanel();
    });
    czrow.append(bm,cv,cm,bp);
    zoneHdr.append(l2,czrow);
    const zlist=document.createElement('div'); zlist.className='cfg-zone-list';
    s2.append(zoneHdr,zlist);

    // only show active zones in the list
    this._cfg.zones.slice(0, this._cfg.active_zones).forEach((z,i)=>{
      const item=document.createElement('div');
      item.className='cfg-zone-item';
      item.draggable=true;

      // row 1: handle · seq · schedule-cb · name
      const r1=document.createElement('div'); r1.className='cfg-zone-row1';
      const handle=document.createElement('div'); handle.className='drag-handle'; handle.textContent='⠿';
      const seqB=document.createElement('div'); seqB.className='cfg-zone-seq'; seqB.textContent=i+1;

      const schCb=document.createElement('input'); schCb.type='checkbox'; schCb.className='cfg-slot-cb';
      schCb.checked=z.schedule_enabled!==false; schCb.title='Include in schedule';
      schCb.addEventListener('change',()=>{
        this._cfg.zones[i].schedule_enabled=schCb.checked;
        this._saveConfig({zones:JSON.parse(JSON.stringify(this._cfg.zones))});
        this._buildZoneGrid(); this._update();
      });

      const nameInp=document.createElement('input'); nameInp.type='text'; nameInp.className='cfg-zone-name';
      nameInp.value=z.name; nameInp.placeholder='Zone name';
      nameInp.dataset.zoneNameIdx=i; // picked up by Save button
      r1.append(handle,seqB,schCb,nameInp);

      // row 2: switch entity
      const r2=document.createElement('div'); r2.className='cfg-zone-row2';
      const swLbl=document.createElement('span'); swLbl.className='cfg-row2-lbl'; swLbl.textContent='Switch Entity:';
      const swWrap=this._makeEntityInput(z.sw||'',(val)=>{ this._cfg.zones[i].sw=val; this._saveConfig({zones:this._cfg.zones}); });
      r2.append(swLbl,swWrap);

      // row 3: duration entity
      const r3=document.createElement('div'); r3.className='cfg-zone-row2';
      const durLbl=document.createElement('span'); durLbl.className='cfg-row2-lbl'; durLbl.textContent='Duration Entity:';
      const durWrap=this._makeEntityInput(z.dur||'',(val)=>{ this._cfg.zones[i].dur=val; this._saveConfig({zones:this._cfg.zones}); });
      r3.append(durLbl,durWrap);

      item.append(r1,r2,r3);

      // drag
      item.addEventListener('dragstart',(e)=>{ this._cfgDragSrc=i; item.classList.add('cfg-zone-item--dragging'); e.dataTransfer.effectAllowed='move'; });
      item.addEventListener('dragend',()=>{ item.classList.remove('cfg-zone-item--dragging'); zlist.querySelectorAll('.cfg-zone-item').forEach(el=>el.classList.remove('cfg-zone-item--drag-over')); });
      item.addEventListener('dragover',(e)=>{ e.preventDefault(); e.dataTransfer.dropEffect='move'; item.classList.add('cfg-zone-item--drag-over'); });
      item.addEventListener('dragleave',()=>item.classList.remove('cfg-zone-item--drag-over'));
      item.addEventListener('drop',(e)=>{ e.preventDefault(); item.classList.remove('cfg-zone-item--drag-over');
        if (this._cfgDragSrc===undefined||this._cfgDragSrc===i) return;
        const zones=JSON.parse(JSON.stringify(this._cfg.zones));
        const [mv]=zones.splice(this._cfgDragSrc,1); zones.splice(i,0,mv);
        this._saveConfig({zones}); this._renderConfigPanel(); this._buildZoneGrid(); this._update();
      });
      zlist.appendChild(item);
    });

    // ── Settings ──
    const s3=document.createElement('div'); s3.className='cfg-section';
    const l3=document.createElement('div'); l3.className='cfg-label'; l3.textContent='Settings';
    const slist=document.createElement('div'); slist.className='cfg-settings-list';

    // nav path — plain text, save on blur
    const navRow=document.createElement('div'); navRow.className='cfg-field-row';
    const navLbl=document.createElement('label'); navLbl.className='cfg-field-lbl'; navLbl.textContent='Nav path';
    const navInp=document.createElement('input'); navInp.type='text'; navInp.className='cfg-field-input';
    navInp.value=this._cfg.nav_path||''; navInp.placeholder='/lovelace/home';
    navInp.dataset.cfgKey='nav_path';
    navRow.append(navLbl,navInp); slist.appendChild(navRow);

    // rain threshold
    const rtRow=document.createElement('div'); rtRow.className='cfg-field-row';
    const rtLbl=document.createElement('label'); rtLbl.className='cfg-field-lbl'; rtLbl.textContent='Rain limit';
    const rtInp=document.createElement('input'); rtInp.type='number'; rtInp.className='cfg-field-input';
    rtInp.value=this._cfg.rain_threshold||5; rtInp.placeholder='5'; rtInp.min=0; rtInp.max=100;
    rtInp.dataset.cfgKey='rain_threshold';
    const rtHint=document.createElement('span'); rtHint.style.cssText='font-size:9px;color:var(--secondary-text-color,#666);flex-shrink:0'; rtHint.textContent='mm → disable sched';
    rtRow.append(rtLbl,rtInp,rtHint); slist.appendChild(rtRow);

    // jojo low %
    const jlRow=document.createElement('div'); jlRow.className='cfg-field-row';
    const jlLbl=document.createElement('label'); jlLbl.className='cfg-field-lbl'; jlLbl.textContent='Jojo low %';
    const jlInp=document.createElement('input'); jlInp.type='number'; jlInp.className='cfg-field-input';
    jlInp.value=this._cfg.jojo_low_pct||35; jlInp.placeholder='35'; jlInp.min=0; jlInp.max=100;
    jlInp.dataset.cfgKey='jojo_low_pct';
    const jlHint=document.createElement('span'); jlHint.style.cssText='font-size:9px;color:var(--secondary-text-color,#666);flex-shrink:0'; jlHint.textContent='% → shut off zones';
    jlRow.append(jlLbl,jlInp,jlHint); slist.appendChild(jlRow);

    // entity fields
    [{label:'Rain sensor',key:'rain_sensor',val:this._cfg.rain_sensor||''},{label:'Weather',key:'weather_entity',val:this._cfg.weather_entity||''},{label:'Jojo sensor',key:'jojo_sensor',val:this._cfg.jojo_sensor||''},{label:'Schedule sw',key:'schedule_entity',val:this._cfg.schedule_entity||''}]
    .forEach(f=>{
      const row=document.createElement('div'); row.className='cfg-field-row';
      const lbl=document.createElement('label'); lbl.className='cfg-field-lbl'; lbl.textContent=f.label;
      const wrap=this._makeEntityInput(f.val,(val)=>{ this._saveConfig({[f.key]:val}); this._update(); });
      row.append(lbl,wrap); slist.appendChild(row);
    });
    s3.append(l3,slist);

    // ── Info bar slots ──
    const s4=document.createElement('div'); s4.className='cfg-section';
    const l4=document.createElement('div'); l4.className='cfg-label'; l4.textContent='Info bar (4 slots)';
    s4.appendChild(l4);
    const slots=this._cfg.meta_slots||JSON.parse(JSON.stringify(DEFAULT_META_SLOTS));
    slots.forEach((slot,si)=>{
      const wrap=document.createElement('div'); wrap.style.cssText='border:1px solid rgba(255,255,255,0.07);border-radius:7px;padding:7px 8px;margin-bottom:5px;background:rgba(255,255,255,0.02)';
      const isEnabled = slot.enabled!==false;

      // slot header with checkbox
      const slotHdr=document.createElement('div'); slotHdr.className='cfg-slot-header';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.className='cfg-slot-cb'; cb.checked=isEnabled;
      const slotTitle=document.createElement('div');
      slotTitle.className='cfg-slot-title'+(isEnabled?' cfg-slot-title--enabled':'');
      slotTitle.textContent='Slot '+(si+1);

      cb.addEventListener('change',()=>{
        this._cfg.meta_slots[si].enabled=cb.checked;
        slotTitle.className='cfg-slot-title'+(cb.checked?' cfg-slot-title--enabled':'');
        fieldsWrap.style.display=cb.checked?'block':'none';
        this._saveConfig({meta_slots:JSON.parse(JSON.stringify(this._cfg.meta_slots))});
        this._updateMeta();
      });
      slotHdr.append(cb,slotTitle);

      // collapsible fields
      const fieldsWrap=document.createElement('div'); fieldsWrap.style.display=isEnabled?'block':'none';

      const nameRow=document.createElement('div'); nameRow.className='cfg-field-row'; nameRow.style.marginBottom='4px';
      const nameLbl=document.createElement('label'); nameLbl.className='cfg-field-lbl'; nameLbl.textContent='Label';
      const nameInp=document.createElement('input'); nameInp.type='text'; nameInp.className='cfg-field-input';
      nameInp.value=slot.label||''; nameInp.placeholder='e.g. Rain last 24h';
      nameInp.addEventListener('change',()=>{ this._cfg.meta_slots[si].label=nameInp.value; this._saveConfig({meta_slots:JSON.parse(JSON.stringify(this._cfg.meta_slots))}); this._updateMeta(); });
      nameInp.addEventListener('blur',()=>{ this._cfg.meta_slots[si].label=nameInp.value; this._saveConfig({meta_slots:JSON.parse(JSON.stringify(this._cfg.meta_slots))}); this._updateMeta(); });
      nameRow.append(nameLbl,nameInp);

      // icon row
      const iconRow=document.createElement('div'); iconRow.className='cfg-field-row'; iconRow.style.marginBottom='4px';
      const iconLbl=document.createElement('label'); iconLbl.className='cfg-field-lbl'; iconLbl.textContent='Icon';
      const iconPreview=document.createElement('div'); iconPreview.className='icon-preview'+(slot.icon?' icon-preview--set':'');
      if (slot.icon) {
        const ic=document.createElement('ha-icon'); ic.setAttribute('icon','mdi:'+slot.icon);
        ic.style.cssText='--mdc-icon-size:14px;color:#4dc49a'; iconPreview.appendChild(ic);
      }
      const iconWrap=this._makeIconInput(slot.icon||'', iconPreview, (val)=>{ this._cfg.meta_slots[si].icon=val; this._saveConfig({meta_slots:JSON.parse(JSON.stringify(this._cfg.meta_slots))}); this._updateMeta(); });
      iconRow.append(iconLbl,iconPreview,iconWrap);
      nameRow.append(nameLbl,nameInp);

      const s1row=document.createElement('div'); s1row.className='cfg-field-row'; s1row.style.marginBottom='4px';
      const s1lbl=document.createElement('label'); s1lbl.className='cfg-field-lbl'; s1lbl.textContent='Sensor 1';
      const s1wrap=this._makeEntityInput(slot.sensor1||'',(val)=>{ this._cfg.meta_slots[si].sensor1=val; this._saveConfig({meta_slots:JSON.parse(JSON.stringify(this._cfg.meta_slots))}); this._updateMeta(); });
      s1row.append(s1lbl,s1wrap);

      const s2row=document.createElement('div'); s2row.className='cfg-field-row';
      const s2lbl=document.createElement('label'); s2lbl.className='cfg-field-lbl'; s2lbl.textContent='Sensor 2';
      const s2wrap=this._makeEntityInput(slot.sensor2||'',(val)=>{ this._cfg.meta_slots[si].sensor2=val; this._saveConfig({meta_slots:JSON.parse(JSON.stringify(this._cfg.meta_slots))}); this._updateMeta(); });
      s2row.append(s2lbl,s2wrap);

      fieldsWrap.append(nameRow,iconRow,s1row,s2row);
      wrap.append(slotHdr,fieldsWrap);
      s4.appendChild(wrap);
    });

    // ── Rules ──
    const s5=document.createElement('div'); s5.className='cfg-section';
    const l5=document.createElement('div'); l5.className='cfg-label'; l5.textContent='Automation Rules'; 
    const l5hint=document.createElement('span'); l5hint.style.cssText='font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--secondary-text-color,#666);margin-left:6px'; l5hint.textContent='(untick rules not needed)';
    l5.appendChild(l5hint);
    s5.appendChild(l5);

    const rules = this._cfg.rules || {};
    const rulesDef = [
      {
        key:'rain_disable_schedule',
        title:'Rain: Auto-disable schedule',
        desc:`If rain sensor exceeds ${this._cfg.rain_threshold||5}mm, the schedule switch is automatically turned off. Rain value turns yellow in info bar.`,
      },
      {
        key:'jojo_shutoff_zones',
        title:'Jojo: Low-level zone shutoff',
        desc:`If tank level drops below ${this._cfg.jojo_low_pct||35}%, all running zones are immediately switched off. Jojo info bar turns red.`,
      },
    ];
    // confirm actions toggle (stored at top level, not inside rules)
    const confirmRow=document.createElement('div'); confirmRow.className='rule-item'+(this._cfg.confirm_actions?' rule-item--enabled':'');
    const confirmCb=document.createElement('input'); confirmCb.type='checkbox'; confirmCb.className='rule-cb'; confirmCb.checked=this._cfg.confirm_actions!==false;
    const confirmTxt=document.createElement('div'); confirmTxt.className='rule-text';
    const confirmTitle=document.createElement('div'); confirmTitle.className='rule-title'; confirmTitle.textContent='Confirm before activating';
    const confirmDesc=document.createElement('div'); confirmDesc.className='rule-desc'; confirmDesc.textContent='Show a confirmation popup before turning zones on/off, All Off, Start Schedule, and schedule toggle.';
    confirmTxt.append(confirmTitle,confirmDesc);
    confirmCb.addEventListener('change',()=>{
      confirmRow.className='rule-item'+(confirmCb.checked?' rule-item--enabled':'');
      this._cfg.confirm_actions=confirmCb.checked;
      this._saveConfig({confirm_actions:confirmCb.checked});
    });
    confirmRow.append(confirmCb,confirmTxt); s5.appendChild(confirmRow);
    rulesDef.forEach(rd=>{
      const enabled = rules[rd.key]!==false;
      const ruleEl=document.createElement('div'); ruleEl.className='rule-item'+(enabled?' rule-item--enabled':'');
      const cb=document.createElement('input'); cb.type='checkbox'; cb.className='rule-cb'; cb.checked=enabled;
      const txt=document.createElement('div'); txt.className='rule-text';
      const title=document.createElement('div'); title.className='rule-title'; title.textContent=rd.title;
      const desc=document.createElement('div'); desc.className='rule-desc'; desc.textContent=rd.desc;
      txt.append(title,desc);
      cb.addEventListener('change',()=>{
        rules[rd.key]=cb.checked;
        ruleEl.className='rule-item'+(cb.checked?' rule-item--enabled':'');
        this._saveConfig({rules:{...rules}});
      });
      ruleEl.append(cb,txt); s5.appendChild(ruleEl);
    });

    body.append(s2,s3,s4,s5);
  }

  _doSave(btn) {
    const panel = this.shadowRoot.getElementById('cfg-panel');
    // collect zone names
    panel.querySelectorAll('[data-zone-name-idx]').forEach(inp=>{
      const idx=parseInt(inp.dataset.zoneNameIdx);
      if (this._cfg.zones[idx]) this._cfg.zones[idx].name=inp.value.trim()||this._cfg.zones[idx].name;
    });
    // collect settings fields
    const navEl=panel.querySelector('[data-cfg-key="nav_path"]');
    if (navEl) this._cfg.nav_path=navEl.value;
    const rtEl=panel.querySelector('[data-cfg-key="rain_threshold"]');
    if (rtEl) this._cfg.rain_threshold=parseFloat(rtEl.value)||5;
    const jlEl=panel.querySelector('[data-cfg-key="jojo_low_pct"]');
    if (jlEl) this._cfg.jojo_low_pct=parseFloat(jlEl.value)||35;

    // save directly via HA websocket — bypasses sections layout config-changed limitation
    const configToSave = JSON.parse(JSON.stringify(this._cfg));
    console.log('[SprinklerCard] _doSave saving via websocket, zones[0].name =', configToSave?.zones?.[0]?.name);
    this._saveViaWebsocket(configToSave, btn);

    // update zone name spans in grid
    this._activeZones().forEach((z,i)=>{
      const span=this.shadowRoot.getElementById('zone-'+i)?.querySelector('.zname');
      if (span) span.textContent=z.name;
    });
    this._buildZoneGrid();
    this._update();
  }

  async _saveViaWebsocket(newCardConfig, btn) {
    try {
      const conn = this._hass.connection;
      const lovelace = await conn.sendMessagePromise({ type: 'lovelace/config' });

      // recursively find and replace the sprinkler card anywhere in the config
      const replaceCard = (cards) => {
        if (!Array.isArray(cards)) return false;
        for (let i = 0; i < cards.length; i++) {
          const c = cards[i];
          if (c.type === 'custom:sprinkler-dash-card-v2') {
            cards[i] = { type: 'custom:sprinkler-dash-card-v2', ...newCardConfig };
            return true;
          }
          // recurse into nested cards (vertical-stack, grid, sections, etc)
          if (replaceCard(c.cards)) return true;
          if (replaceCard(c.sections?.flatMap?.(s => s.cards))) return true;
        }
        return false;
      };

      let found = false;
      for (const view of (lovelace.views || [])) {
        if (replaceCard(view.cards)) { found = true; break; }
        for (const section of (view.sections || [])) {
          if (replaceCard(section.cards)) { found = true; break; }
        }
        if (found) break;
      }

      if (!found) { console.warn('[SprinklerCard] card not found in lovelace config'); return; }

      await conn.sendMessagePromise({ type: 'lovelace/config/save', config: lovelace });
      console.log('[SprinklerCard] saved OK');

      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✓ Saved!';
        btn.style.background = 'rgba(26,138,100,0.5)';
        setTimeout(()=>{ btn.textContent=orig; btn.style.background='linear-gradient(135deg,#0a5c45,#1a8a64)'; }, 1500);
      }
    } catch(e) {
      console.error('[SprinklerCard] save failed', e);
      if (btn) { btn.textContent = '✗ Failed'; setTimeout(()=>{ btn.textContent='💾 Save'; }, 2000); }
    }
  }

  _toggleDay(day) {
    const e=this._cfg.schedule_entity; if(!e)return;
    const cur=this._hass.states[e]?.attributes?.weekdays||[];
    const next=cur.includes(day)?cur.filter(d=>d!==day):[...cur,day];
    this._svc('scheduler','edit',{entity_id:e,weekdays:next});
  }

  _saveTime(ts) {
    const e=this._cfg.schedule_entity; if(!e)return;
    this._svc('scheduler','edit',{entity_id:e,timeslots:[{start:ts+':00',actions:[{service:'script.turn_on',entity_id:'script.sprinkler'}]}]});
  }

  _update() { this._updateMeta(); this._updateZones(); this._updateSchedule(); }

  _updateMeta() {
    const meta=this.shadowRoot.getElementById('hdr-meta'); if(!meta)return;
    meta.innerHTML='';
    const slots = this._cfg.meta_slots || DEFAULT_META_SLOTS;
    const jojoLow = parseFloat(this._cfg.jojo_low_pct)||35;
    const rainThresh = parseFloat(this._cfg.rain_threshold)||5;
    const activeSlots = slots.filter(s=>s.enabled!==false);

    // set grid class based on count of enabled slots
    meta.className = 'hdr-meta';
    if (activeSlots.length===0) { meta.classList.add('hdr-meta--empty'); return; }
    meta.classList.add('hdr-meta--'+Math.min(4,activeSlots.length));

    slots.forEach(slot=>{
      if (slot.enabled===false) return;
      if (!slot.sensor1 && !slot.sensor2) return;
      const s1 = slot.sensor1 && this._hass.states[slot.sensor1];
      const s2 = slot.sensor2 && this._hass.states[slot.sensor2];
      if (!s1 && !s2) return;

      const it=document.createElement('div'); it.className='hdr-meta-item';
      let parts=[], warn=false;

      // MDI icon
      if (slot.icon) {
        const ic=document.createElement('ha-icon');
        ic.setAttribute('icon','mdi:'+slot.icon);
        ic.style.cssText='--mdc-icon-size:13px;flex-shrink:0;margin-right:1px';
        it.appendChild(ic);
      }

      if (slot.label) parts.push(slot.label+':');

      if (s1) {
        const e1=slot.sensor1;
        if (e1.startsWith('weather.')) {
          const icons={sunny:'☀️','clear-night':'🌙',cloudy:'☁️',partlycloudy:'⛅',rainy:'🌧️',snowy:'❄️',windy:'💨',fog:'🌫️',lightning:'⛈️','lightning-rainy':'⛈️'};
          const temp=s1.attributes.temperature;
          // for weather, skip emoji if we have an mdi icon set
          const condStr = slot.icon ? s1.state+(temp!==undefined?' · '+temp+'°':'') : (icons[s1.state]||'🌡️')+' '+s1.state+(temp!==undefined?' · '+temp+'°':'');
          parts=[(slot.label?slot.label+': ':'')+condStr];
        } else {
          const val1=s1.state, unit1=s1.attributes.unit_of_measurement||'';
          if (e1===this._cfg.rain_sensor||unit1==='mm') {
            const numVal=parseFloat(val1)||0;
            if (numVal>=rainThresh && this._cfg.rules?.rain_disable_schedule!==false) {
              warn=true;
              if (this._cfg.schedule_entity&&this._hass.states[this._cfg.schedule_entity]?.state==='on')
                this._svc('switch','turn_off',{entity_id:this._cfg.schedule_entity});
            }
          }
          if (s2 && slot.sensor2.includes('liquid_level')) {
            const pct=parseFloat(s2.state);
            if (pct<jojoLow && this._cfg.rules?.jojo_shutoff_zones!==false) {
              warn=true;
              it.title='Jojo below '+jojoLow+'% — all zones shut off';
              const running=this._activeZones().map(z=>z.sw).filter(sw=>sw&&this._hass.states[sw]?.state==='on');
              if (running.length) { this._svc('switch','turn_off',{entity_id:running}); }
            }
            const unit1=s1.attributes.unit_of_measurement||'';
            parts.push(parseFloat(val1).toLocaleString()+(unit1?' '+unit1:'')+' - '+pct.toFixed(0)+'%');
          } else {
            parts.push(val1+(unit1 ? (unit1==='%' ? unit1 : ' '+unit1) : ''));
            if (s2) {
              const val2=s2.state, unit2=s2.attributes.unit_of_measurement||'';
              parts.push('- '+val2+(unit2 ? (unit2==='%' ? unit2 : ' '+unit2) : ''));
            }
          }
        }
      } else if (s2) {
        const val2=s2.state, unit2=s2.attributes.unit_of_measurement||'';
        parts.push(val2+(unit2?' '+unit2:''));
      }

      const cap = s => s ? s.split(' ').map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(' ') : s;
      const finalText = parts.map((p,i) => i===0 ? cap(p) : p.replace(/^(·|- ?)(.+)/, (m,pre,val) => pre+cap(val))).join(' ');
      it.appendChild(document.createTextNode(finalText));
      if (warn) it.style.color='#ffcc44';
      // click opens more-info for sensor1
      if (slot.sensor1) {
        it.addEventListener('click',()=>{
          this.dispatchEvent(new CustomEvent('hass-more-info',{detail:{entityId:slot.sensor1},bubbles:true,composed:true}));
        });
      }
      meta.appendChild(it);
    });

    // if only 1 item, span full width
    const items = meta.querySelectorAll('.hdr-meta-item');
    if (items.length===1) items[0].style.gridColumn='1 / -1';
  }

  _updateZones() {
    if(!this._built)return;
    let active=0;
    this._activeZones().forEach((z,i)=>{
      const isOn=z.sw&&this._hass.states[z.sw]?.state==='on';
      const durVal=z.dur?parseFloat(this._hass.states[z.dur]?.state||10):10;
      const durMin=z.dur?parseFloat(this._hass.states[z.dur]?.attributes?.min??0):0;
      const durMax=z.dur?parseFloat(this._hass.states[z.dur]?.attributes?.max??60):60;
      const lc=z.sw&&this._hass.states[z.sw]?.last_changed;
      if(isOn){
        active++;
        if(!this._onTimes[i]||this._onTimes[i].lastChanged!==lc) this._onTimes[i]={ts:new Date(lc).getTime(),lastChanged:lc,totalSecs:durVal*60};
        else if(this._prevDurVals[i]!==undefined&&this._prevDurVals[i]!==durVal) this._onTimes[i].totalSecs=durVal*60;
      } else { delete this._onTimes[i]; }
      this._prevDurVals[i]=durVal;
      this.shadowRoot.getElementById('zone-'+i)?.classList.toggle('zone--on',isOn);
      this.shadowRoot.getElementById('zone-'+i)?.classList.toggle('zone--disabled', z.schedule_enabled===false);
      const skipped = this._isZoneSkipped(z);
      this.shadowRoot.getElementById('zone-'+i)?.classList.toggle('zone--skip', skipped && !isOn);
      this.shadowRoot.getElementById('zskip-'+i)?.classList.toggle('zskip--active', skipped);
      const skipEl = this.shadowRoot.getElementById('zskip-'+i);
      if (skipEl) skipEl.title = skipped ? 'Skipped — tap to cancel' : 'Skip next scheduled run';
      this.shadowRoot.getElementById('zseq-'+i)?.classList.toggle('zseq--on',isOn);
      this.shadowRoot.getElementById('ztog-'+i)?.classList.toggle('ztoggle--on',isOn);
      const inp=this.shadowRoot.getElementById('zdur-'+i);
      if(inp&&inp!==this.shadowRoot.activeElement){inp.min=durMin;inp.max=durMax;inp.value=durVal;}
      const elapsed=isOn&&this._onTimes[i]?(Date.now()-this._onTimes[i].ts)/1000:0;
      this._renderProgress(i,isOn,elapsed,this._onTimes[i]?.totalSecs||durVal*60, skipped);
    });
    const badge=this.shadowRoot.getElementById('hdr-badge');
    if(badge){badge.textContent=active>0?active+' watering':this._cfg.active_zones+' zones';badge.className='badge'+(active>0?' badge--active':'');}
  }

  _updateSchedule() {
    if(!this._built)return;
    const e=this._cfg.schedule_entity; if(!e||!this._hass.states[e])return;
    const ent=this._hass.states[e], isOn=ent.state==='on', attrs=ent.attributes||{};
    const tog=this.shadowRoot.getElementById('sched-toggle'); if(tog)tog.className='stoggle'+(isOn?' stoggle--on':'');
    this._days.forEach(d=>{ const el=this.shadowRoot.getElementById('sday-'+d); if(el)el.className='sday'+((attrs.weekdays||[]).includes(d)?' sday--on':''); });
    const timeEl=this.shadowRoot.getElementById('sched-time');
    if(timeEl&&!this._editingTime){ const t=(attrs.timeslots||[])[0]||''; timeEl.textContent=(typeof t==='string'?t:(t.start||'')).substring(0,5)||'--:--'; }
    const nextEl=this.shadowRoot.getElementById('sched-next');
    if(nextEl&&attrs.next_trigger){
      const d=new Date(attrs.next_trigger),now=new Date(),diff=d-now;
      const h=Math.floor(diff/3600000),m=Math.floor((diff%3600000)/60000);
      const label=diff<0?'overdue':h<24?'in '+(h>0?h+'h ':'')+m+'m':['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      nextEl.textContent=isOn?'next: '+label:'disabled';
      nextEl.className='sched-next'+(isOn?' sched-next--on':'');
    }
  }

  _renderProgress(i,isOn,elapsed,total,skipped){
    const prog=this.shadowRoot.getElementById('zprog-'+i), stat=this.shadowRoot.getElementById('zstat-'+i);
    if(!prog||!stat)return;
    if(!isOn||total===0){
      prog.style.width='0%';
      if (skipped) { stat.className='zstat zstat--skip'; stat.textContent='Skip next run'; }
      else { stat.className='zstat'; stat.textContent='Ready'; }
      return;
    }
    prog.style.width=Math.min(100,(elapsed/total)*100).toFixed(2)+'%';
    const rem=Math.max(0,Math.round(total-elapsed)),m=Math.floor(rem/60),s=rem%60;
    stat.className='zstat zstat--on'; stat.innerHTML='';
    const dot=document.createElement('span'); dot.className='pulse'; stat.appendChild(dot);
    stat.appendChild(document.createTextNode(' '+m+'m '+String(s).padStart(2,'0')+'s left'));
  }

  _tick(){
    if(!this._hass||!this._built)return;
    this._activeZones().forEach((z,i)=>{
      const isOn=z.sw&&this._hass.states[z.sw]?.state==='on';
      const durVal=z.dur?parseFloat(this._hass.states[z.dur]?.state||10):10;
      const elapsed=isOn&&this._onTimes[i]?(Date.now()-this._onTimes[i].ts)/1000:0;
      this._renderProgress(i,isOn,elapsed,this._onTimes[i]?.totalSecs||durVal*60, this._isZoneSkipped(z));
    });
    this._updateSchedule(); this._updateMeta();
  }

  getCardSize(){ return 7; }

  static getConfigElement() { return document.createElement('sprinkler-dash-card-v2'); }
  static getStubConfig() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
}

if(!customElements.get('sprinkler-dash-card-v2')){
  customElements.define('sprinkler-dash-card-v2', SprinklerDashCardV2);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'sprinkler-dash-card-v2',
  name: 'Sprinkler Dash Card',
  description: 'Smart irrigation dashboard with zones, scheduler, rain and tank monitoring',
  preview: false,
});
