const CARD_VERSION = '3.0.2';
const MAX_ZONES = 12;
// ── Server-side engine ──────────────────────────────────────────────
// Everything that must keep working when no browser is open (or when HA
// restarts) lives in Home Assistant itself:
//   timer.sprinkler_zone_N          restore:true timers — one per zone position
//   input_text.sprinkler_queue      "run:3,4,5" while a schedule run is in progress
//   input_text.sprinkler_rain_pause ISO time the rain rule paused the schedule
//   automation.sprinkler_controller auto-generated from the card config
const ENGINE_VERSION = 5;
const CONTROLLER_ID = 'sprinkler_dash_controller';
const QUEUE_E = 'input_text.sprinkler_queue';
const RAIN_PAUSE_E = 'input_text.sprinkler_rain_pause';
const SKIP_E = 'input_text.sprinkler_skip_zones';
const MANUAL_LOG_E = 'input_text.sprinkler_manual_log';
const ADVANCE_EVENT = 'sprinkler_dash_advance';
const zoneTimer = (i) => 'timer.sprinkler_zone_' + (i + 1);
const hhmm00 = (mins) => String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0') + ':00';
const durToSecs = (d) => { if (!d) return 0; const p = String(d).split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : (parseFloat(d) || 0); };
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
  rain_restore_hours: 48,
  rules: {
    rain_disable_schedule: true,
    jojo_shutoff_zones: true,
    rain_auto_restore: true,
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
    this._manualRunLog = [];
    this._engineChecked = false;
    this._engineBusy = false;
    this._engineRebuildTimer = null;
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
    this._saveDebounce = null;
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
    const prevHass = this._hass;
    this._hass = hass;
    if (this._allEntities.length === 0) this._allEntities = Object.keys(hass.states).sort();
    if (!this._mdiLoaded) this._loadMdiIcons();
    if (!this._built) { this._buildShell(); this._built=true; this._loadManualLog(); }
    if (!this._engineChecked) { this._engineChecked = true; this._ensureEngine(); }

    // Stop / Start button follows the server-side run queue (survives restarts)
    const running = this._isRunActive();
    if (running !== this._lastRunning) {
      this._lastRunning = running;
      const stopBtn = this.shadowRoot.getElementById('btn-stop-sched');
      const startBtn = this.shadowRoot.getElementById('btn-start');
      if (stopBtn && startBtn) {
        stopBtn.style.display = running ? '' : 'none';
        startBtn.style.display = running ? 'none' : '';
      }
    }
    if (prevHass && prevHass.states[MANUAL_LOG_E]?.state !== hass.states[MANUAL_LOG_E]?.state) this._loadManualLog();

    this._update();
  }

  _queueState() { return this._hass?.states[QUEUE_E]?.state || ''; }
  _isRunActive() {
    return this._queueState().startsWith('run:') || this._hass?.states['script.sprinkler']?.state === 'on';
  }
  _queuedZoneNums() {
    const q = this._queueState();
    if (!q.startsWith('run:')) return [];
    return q.slice(4).split(',').map(x => parseInt(x)).filter(n => !isNaN(n));
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
    this._scheduleEngineRebuild();
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
    // settle any dialog that is still open, so its OK handler can never fire later
    if (this._confirmResolve) { const prev = this._confirmResolve; this._confirmResolve = null; prev(false); }
    r.getElementById('confirm-title').textContent = title;
    r.getElementById('confirm-msg').textContent = msg;
    const okBtn = r.getElementById('confirm-ok');
    okBtn.className = 'confirm-btn ' + okClass;
    r.getElementById('confirm-modal').classList.add('confirm-modal--open');
    return new Promise(resolve => {
      const finish = (val) => {
        okBtn.removeEventListener('click', onOk);
        r.getElementById('confirm-modal').classList.remove('confirm-modal--open');
        if (this._confirmResolve === finish) this._confirmResolve = null;
        resolve(val);
      };
      const onOk = () => finish(true);
      okBtn.addEventListener('click', onOk);
      this._confirmResolve = finish;
    });
  }

  _zoneSwitches() { return this._activeZones().map(z=>z.sw).filter(Boolean); }

  _clearQueue() {
    if (this._hass.states[QUEUE_E]) this._svc('input_text','set_value',{entity_id:QUEUE_E, value:''});
  }

  _allOff() {
    this._confirm('All Off', 'Turn off all zones and cancel any running schedule?', 'confirm-btn--danger').then(ok => {
      if (!ok) return;
      this._clearQueue();
      const switches = this._zoneSwitches();
      if (switches.length) this._svc('switch','turn_off',{entity_id:switches});
    });
  }

  _startSchedule() {
    this._confirm('Start Schedule', 'Run all scheduled zones now?').then(async ok => {
      if (!ok) return;
      if (!this._hass.states['script.sprinkler'] || !this._hass.states[QUEUE_E]) await this._ensureEngine(true);
      this._svc('script','turn_on',{entity_id:'script.sprinkler'});
    });
  }

  // ── Engine ────────────────────────────────────────────────────────

  // zones as the engine sees them: position-numbered, only zones with a switch
  _engineZones() {
    return this._activeZones().map((z,i)=>({
      n: i+1, sw: z.sw||'', dur: z.dur||'', t: zoneTimer(i), name: z.name||('Zone '+(i+1)),
      sched: z.schedule_enabled !== false,
    })).filter(z => z.sw);
  }

  _jojoLevelEntity() {
    if (this._cfg.jojo_level_sensor) return this._cfg.jojo_level_sensor;
    const slot = (this._cfg.meta_slots||[]).find(s => (s.sensor2||'').includes('liquid_level'));
    if (slot) return slot.sensor2;
    const js = this._cfg.jojo_sensor;
    if (js && this._hass?.states[js]?.attributes?.unit_of_measurement === '%') return js;
    return '';
  }

  _engineSignature() {
    const data = JSON.stringify({
      v: ENGINE_VERSION,
      z: this._engineZones().map(z=>[z.n,z.sw,z.dur,z.sched,z.name]),
      r: this._cfg.rules||{}, rs: this._cfg.rain_sensor||'', rt: this._cfg.rain_threshold||5,
      rh: this._cfg.rain_restore_hours||48, se: this._cfg.schedule_entity||'',
      jl: this._jojoLevelEntity(), jp: this._cfg.jojo_low_pct||35, ns: this._cfg.notify_service||'',
    });
    let h = 5381;
    for (let i = 0; i < data.length; i++) h = ((h << 5) + h + data.charCodeAt(i)) >>> 0;
    return 'sdc-engine:' + ENGINE_VERSION + ':' + h.toString(16);
  }

  _scheduleEngineRebuild() {
    clearTimeout(this._engineRebuildTimer);
    this._engineRebuildTimer = setTimeout(() => this._ensureEngine(), 1500);
  }

  // Make sure helpers, script.sprinkler and the controller automation exist and
  // match the current card config. Rebuilds only when the signature changed.
  async _ensureEngine(force=false) {
    if (!this._hass || this._engineBusy) return;
    if (!this._hass.user?.is_admin) return; // config APIs are admin-only
    this._engineBusy = true;
    try {
      const sig = this._engineSignature();
      await this._ensureHelpers();
      let current = null;
      if (!force) {
        try { current = await this._hass.callApi('GET', 'config/automation/config/' + CONTROLLER_ID); } catch(e) { current = null; }
      }
      const upToDate = current && String(current.description||'').includes(sig) && this._hass.states['script.sprinkler'];
      if (!upToDate) {
        await this._createSprinklerScript();
        await this._hass.callApi('POST', 'config/automation/config/' + CONTROLLER_ID, this._buildController(sig));
        console.log('[SprinklerCard] engine (re)built', sig);
      }
      this._ensureScheduler();
    } catch(e) {
      console.warn('[SprinklerCard] engine setup failed', e);
    } finally {
      this._engineBusy = false;
    }
  }

  async _ensureHelpers() {
    const ws = (m) => this._hass.connection.sendMessagePromise(m);
    const st = this._hass.states;
    const jobs = [];
    const mkText = (name, icon) => ws({ type:'input_text/create', name, max:255, min:0, mode:'text', icon });
    if (!st[SKIP_E]) jobs.push(mkText('Sprinkler Skip Zones', 'mdi:calendar-remove'));
    if (!st[MANUAL_LOG_E]) jobs.push(mkText('Sprinkler Manual Log', 'mdi:water-pump'));
    if (!st[QUEUE_E]) jobs.push(mkText('Sprinkler Queue', 'mdi:playlist-play'));
    if (!st[RAIN_PAUSE_E]) jobs.push(mkText('Sprinkler Rain Pause', 'mdi:weather-pouring'));
    this._engineZones().forEach(z => {
      if (!st[z.t]) jobs.push(ws({ type:'timer/create', name:'Sprinkler Zone '+z.n, duration:'00:10:00', restore:true, icon:'mdi:sprinkler-variant' }));
    });
    const res = await Promise.allSettled(jobs);
    res.filter(r=>r.status==='rejected').forEach(r=>console.warn('[SprinklerCard] helper create failed', r.reason));

    // Helpers created by older versions had an "initial" value, which makes HA
    // reset them on every restart (skip list and manual log were wiped). Strip it.
    const ours = ['sprinkler_skip_zones','sprinkler_manual_log','sprinkler_queue','sprinkler_rain_pause'];
    try {
      const list = await ws({ type:'input_text/list' });
      for (const it of (list||[])) {
        if (!ours.includes(it.id) || it.initial === undefined) continue;
        const { id, initial, ...rest } = it;
        await ws({ type:'input_text/update', input_text_id:id, ...rest });
        console.log('[SprinklerCard] removed initial value from input_text.'+id+' so it survives restarts');
      }
    } catch(e) { console.warn('[SprinklerCard] could not check input_text helpers', e); }
    // Zone timers must restore after a restart
    try {
      const list = await ws({ type:'timer/list' });
      for (const it of (list||[])) {
        if (!/^sprinkler_zone_\d+$/.test(it.id) || it.restore === true) continue;
        const { id, ...rest } = it;
        await ws({ type:'timer/update', timer_id:id, ...rest, restore:true });
      }
    } catch(e) { console.warn('[SprinklerCard] could not check timers', e); }
  }

  _createSprinklerScript() {
    // script.sprinkler only loads the run queue — the controller automation does
    // the watering, so a restart mid-run resumes instead of dying with the script.
    const nums = this._engineZones().filter(z => z.sched).map(z => z.n);
    return this._hass.callApi('POST', 'config/script/config/sprinkler', {
      alias: 'Sprinkler',
      icon: 'mdi:sprinkler-fire',
      description: 'Auto-generated by Sprinkler Dash Card. Loads the run queue; automation.sprinkler_controller runs the zones.',
      mode: 'single',
      sequence: [
        { action:'input_text.set_value', target:{ entity_id: QUEUE_E }, data:{ value: 'run:' + nums.join(',') } },
        { event: ADVANCE_EVENT, event_data: { source: 'script' } },
      ],
    }).catch(err => console.warn('sprinkler-dash-card: could not create script.sprinkler', err));
  }

  _buildController(sig) {
    const Z = this._engineZones();
    const sws = Z.map(z => z.sw);
    const rules = this._cfg.rules || {};
    const sched = this._cfg.schedule_entity || '';
    const rain = this._cfg.rain_sensor || '';
    const thresh = parseFloat(this._cfg.rain_threshold) || 5;
    const restoreH = parseFloat(this._cfg.rain_restore_hours) || 48;
    const level = this._jojoLevelEntity();
    const lowPct = parseFloat(this._cfg.jojo_low_pct) || 35;
    const useRain = rules.rain_disable_schedule !== false && !!rain && !!sched;
    const useRestore = useRain && rules.rain_auto_restore !== false;
    const useJojo = rules.jojo_shutoff_zones !== false && !!level;

    const zoneBy = (key, expr) => "{{ zones | selectattr('" + key + "','eq', " + expr + ") | first | default({}) }}";
    const minsOf = "{{ ((states(z.dur) | int(0)) if z.dur else 10) }}";
    const durTpl = "{{ '%02d:%02d:00' % ((mins | int) // 60, (mins | int) % 60) }}";
    const cont = { continue_on_error: true };
    const advance = { event: ADVANCE_EVENT, event_data: {} };
    const tpl = (t) => ({ condition:'template', value_template: t });
    const notifySvc = /^notify\.[a-z0-9_]+$/.test(this._cfg.notify_service||'') ? this._cfg.notify_service : '';
    // persistent notification always, plus the user's notify service (WhatsApp, phone…) if configured
    const alert = (id, message) => [
      { action:'persistent_notification.create', data:{ title:'Sprinklers', notification_id:id, message } },
      ...(notifySvc ? [{ action: notifySvc, data:{ message: '💧 Sprinklers: ' + message }, continue_on_error: true }] : []),
    ];

    const triggers = [
      { trigger:'event', event_type: ADVANCE_EVENT, id:'advance' },
      ...Z.map(z => ({ trigger:'event', event_type:'timer.finished', event_data:{ entity_id: z.t }, id:'timer_done' })),
      { trigger:'state', entity_id: sws, from:'off', to:'on', id:'zone_on' },
      { trigger:'state', entity_id: sws, from:'on', to:'off', id:'zone_off' },
      { trigger:'homeassistant', event:'start', id:'ha_start' },
      { trigger:'time_pattern', minutes:'/1', id:'watchdog' },
    ];
    // 'for' debounces level-sensor glitches (e.g. 48% -> 30% -> 48% within seconds)
    if (useJojo) triggers.push({ trigger:'numeric_state', entity_id: level, below: lowPct, for:{ minutes: 2 }, id:'jojo_low' });
    if (useRain) {
      triggers.push({ trigger:'numeric_state', entity_id: rain, above: thresh, id:'rain_high' });
      triggers.push({ trigger:'state', entity_id: sched, from:'off', to:'on', id:'sched_on' });
    }

    const jojoAbort = useJojo ? [{
      // only a level that has been low for 2+ minutes counts — a single glitchy reading must not cancel a run
      if: [ tpl("{{ states('" + level + "') | float(100) < " + lowPct + " and (as_timestamp(now()) - as_timestamp((expand('" + level + "') | first).last_changed)) > 120 }}") ],
      then: [
        { action:'input_text.set_value', target:{ entity_id: QUEUE_E }, data:{ value:'' } },
        ...alert('sprinkler_jojo', "Schedule run cancelled — tank level {{ states('" + level + "') }}% is below " + lowPct + "%."),
        { stop: 'tank low' },
      ],
    }] : [];

    const branches = [
      // ── advance: start the next queued zone once nothing is watering
      { conditions:[{ condition:'trigger', id:'advance' }], sequence:[
        { variables:{ q: "{{ states('" + QUEUE_E + "') }}" } },
        tpl("{{ q.startswith('run:') }}"),
        tpl("{{ zones | map(attribute='t') | select('is_state','active') | list | count == 0 }}"),
        { variables:{ rest: "{{ q[4:].split(',') | reject('eq','') | list }}" } },
        { if:[ tpl("{{ rest | count == 0 }}") ], then:[
          { action:'input_text.set_value', target:{ entity_id: QUEUE_E }, data:{ value:'' } },
          { stop:'run complete' },
        ]},
        { variables:{ z: zoneBy('n', "(rest[0] | int(0))"), remaining: "{{ 'run:' ~ (rest[1:] | join(',')) }}" } },
        { action:'input_text.set_value', target:{ entity_id: QUEUE_E }, data:{ value: "{{ remaining }}" } },
        ...jojoAbort,
        { if:[ tpl("{{ not z.get('sw') }}") ], then:[ advance, { stop:'unknown zone' } ] },
        { if:[ tpl("{{ z.sw in (states('" + SKIP_E + "') | default('')).split(',') }}") ], then:[
          { action:'input_text.set_value', target:{ entity_id: SKIP_E },
            data:{ value: "{{ (states('" + SKIP_E + "') | default('')).split(',') | reject('eq', z.sw) | reject('eq','') | join(',') }}" } },
          advance, { stop:'skipped' },
        ]},
        { variables:{ mins: minsOf } },
        { if:[ tpl("{{ mins | int(0) <= 0 }}") ], then:[ advance, { stop:'zero duration' } ] },
        { action:'timer.start', target:{ entity_id: "{{ z.t }}" }, data:{ duration: durTpl }, ...cont },
        { action:'switch.turn_on', target:{ entity_id: "{{ z.sw }}" }, ...cont },
        { wait_template: "{{ is_state(z.sw, 'on') }}", timeout:'00:00:20', continue_on_timeout:true },
        { if:[ tpl("{{ not is_state(z.sw, 'on') }}") ], then:[
          { action:'switch.turn_on', target:{ entity_id: "{{ z.sw }}" }, ...cont },
        ]},
      ]},

      // ── timer finished: close the valve (verify + retry), then continue the run
      { conditions:[{ condition:'trigger', id:'timer_done' }], sequence:[
        { variables:{ z: zoneBy('t', 'trigger.event.data.entity_id') } },
        tpl("{{ z.get('sw','') != '' }}"),
        { action:'switch.turn_off', target:{ entity_id: "{{ z.sw }}" }, ...cont },
        { repeat:{
          sequence:[
            { wait_template: "{{ not is_state(z.sw, 'on') }}", timeout:'00:00:15', continue_on_timeout:true },
            { if:[ tpl("{{ is_state(z.sw, 'on') }}") ], then:[
              { action:'switch.turn_off', target:{ entity_id: "{{ z.sw }}" }, ...cont },
            ]},
          ],
          until:[ tpl("{{ not is_state(z.sw, 'on') or repeat.index >= 3 }}") ],
        }},
        { if:[ tpl("{{ is_state(z.sw, 'on') }}") ], then:[
          ...alert('sprinkler_stuck', "{{ z.name }} did not turn off after 3 attempts — check the valve."),
        ]},
        advance,
      ]},

      // ── any zone turned on (card toggle, eWeLink app, another automation): arm its timer
      { conditions:[{ condition:'trigger', id:'zone_on' }], sequence:[
        { variables:{ z: zoneBy('sw', 'trigger.entity_id') } },
        tpl("{{ z.get('t','') != '' and not is_state(z.t, 'active') }}"),
        { variables:{ mins: "{{ [ ((states(z.dur) | int(0)) if z.dur else 10), 1 ] | max }}" } },
        { action:'timer.start', target:{ entity_id: "{{ z.t }}" }, data:{ duration: durTpl }, ...cont },
      ]},

      // ── zone turned off early: drop its timer, let the run continue
      { conditions:[{ condition:'trigger', id:'zone_off' }], sequence:[
        { variables:{ z: zoneBy('sw', 'trigger.entity_id') } },
        { if:[ tpl("{{ z.get('t','') != '' and states(z.t) in ['active','paused'] }}") ], then:[
          { action:'timer.cancel', target:{ entity_id: "{{ z.t }}" }, ...cont },
        ]},
        advance,
      ]},

      // ── HA restarted: timers restore themselves; close any valve whose timer
      //    already ran out while HA was down, then resume the queued run
      { conditions:[{ condition:'trigger', id:'ha_start' }], sequence:[
        { delay:'00:01:00' },
        { repeat:{ for_each: "{{ zones }}", sequence:[
          { if:[ tpl("{{ is_state(repeat.item.sw, 'on') and not is_state(repeat.item.t, 'active') }}") ], then:[
            { action:'switch.turn_off', target:{ entity_id: "{{ repeat.item.sw }}" }, ...cont },
          ]},
        ]}},
        advance,
      ]},

      // ── every minute: safety net + rain auto-restore
      { conditions:[{ condition:'trigger', id:'watchdog' }], sequence:[
        { repeat:{ for_each: "{{ zones }}", sequence:[
          { if:[ tpl("{{ is_state(repeat.item.sw, 'on') and is_state(repeat.item.t, 'idle') and (as_timestamp(now()) - as_timestamp((expand(repeat.item.sw) | first).last_changed)) > 120 }}") ], then:[
            { variables:{ z: "{{ repeat.item }}" } },
            { variables:{ mins: "{{ [ ((states(z.dur) | int(0)) if z.dur else 10), 1 ] | max }}" } },
            { action:'timer.start', target:{ entity_id: "{{ z.t }}" }, data:{ duration: durTpl }, ...cont },
          ]},
        ]}},
        ...(useRestore ? [{ if:[ tpl(
          "{{ states('" + RAIN_PAUSE_E + "') not in ['', 'unknown', 'unavailable'] and is_state('" + sched + "', 'off')" +
          " and states('" + rain + "') | float(0) < " + thresh +
          " and (as_timestamp(now()) - as_timestamp(states('" + RAIN_PAUSE_E + "'), as_timestamp(now()))) >= " + Math.round(restoreH * 3600) + " }}"
        ) ], then:[
          { action:'input_text.set_value', target:{ entity_id: RAIN_PAUSE_E }, data:{ value:'' } },
          { action:'switch.turn_on', target:{ entity_id: sched } },
        ]}] : []),
      ]},
    ];

    if (useJojo) branches.push({ conditions:[{ condition:'trigger', id:'jojo_low' }], sequence:[
      { action:'input_text.set_value', target:{ entity_id: QUEUE_E }, data:{ value:'' } },
      { action:'switch.turn_off', target:{ entity_id: sws }, ...cont },
      ...alert('sprinkler_jojo', "Tank level {{ states('" + level + "') }}% stayed below " + lowPct + "% — all zones switched off. Scheduled runs stay blocked until it refills."),
    ]});
    if (useRain) {
      branches.push({ conditions:[{ condition:'trigger', id:'rain_high' }], sequence:[
        { if:[ { condition:'state', entity_id: sched, state:'on' } ], then:[
          { action:'switch.turn_off', target:{ entity_id: sched } },
          { action:'input_text.set_value', target:{ entity_id: RAIN_PAUSE_E }, data:{ value: "{{ now().isoformat() }}" } },
        ], else:[
          // more rain while already paused: restart the countdown
          { if:[ tpl("{{ states('" + RAIN_PAUSE_E + "') not in ['', 'unknown', 'unavailable'] }}") ], then:[
            { action:'input_text.set_value', target:{ entity_id: RAIN_PAUSE_E }, data:{ value: "{{ now().isoformat() }}" } },
          ]},
        ]},
      ]});
      // schedule switched on by hand (or by the restore) — no pending rain pause
      branches.push({ conditions:[{ condition:'trigger', id:'sched_on' }], sequence:[
        { action:'input_text.set_value', target:{ entity_id: RAIN_PAUSE_E }, data:{ value:'' } },
      ]});
    }

    return {
      alias: 'Sprinkler Controller',
      description: 'Auto-generated by Sprinkler Dash Card — edits are overwritten when the card config changes. Runs the zone queue, auto-stops every zone, survives restarts. [' + sig + ']',
      mode: 'queued',
      max: 50,
      max_exceeded: 'silent',
      variables: { zones: Z.map(z => ({ n:z.n, sw:z.sw, dur:z.dur, t:z.t, name:z.name })) },
      triggers,
      conditions: [],
      actions: [{ choose: branches }],
    };
  }

  _ensureScheduler() {
    const hasSched = Object.values(this._hass.states).some(s =>
      s.entity_id.startsWith('switch.schedule_') &&
      (s.attributes.entities||[]).includes('script.sprinkler')
    );
    if (!hasSched && this._hass.services?.scheduler?.add) this._createSchedulerEntity();
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
    .hbtn--stop-sched{background:rgba(210,45,45,0.85);color:#fff}
    .hbtn--lastrun{background:rgba(255,255,255,0.92);color:#0a5c45}
    .zlast{font-size:10px;color:var(--secondary-text-color,#666);min-height:12px}
    .zlast--recent{color:#4dc49a}
    /* last-run modal */
    .lastrun-modal{display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.75);align-items:center;justify-content:center;padding:16px}
    .lastrun-modal--open{display:flex}
    .lastrun-box{background:#1a1a1a;border:1px solid rgba(77,196,154,0.3);border-radius:12px;max-width:400px;width:100%;max-height:75vh;display:flex;flex-direction:column;overflow:hidden}
    .lastrun-hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 10px;border-bottom:1px solid rgba(77,196,154,0.15);flex-shrink:0;gap:8px}
    .lastrun-hdr h3{margin:0;font-size:14px;color:#4dc49a;font-weight:700;flex:1;white-space:nowrap}
    .lastrun-close-btn{padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.06);color:var(--secondary-text-color,#aaa);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0}
    .lastrun-close-btn:hover{background:rgba(255,255,255,0.12)}
    .lastrun-body{padding:14px 16px;overflow-y:auto;flex:1;font-size:12px;color:var(--secondary-text-color,#aaa);line-height:1.7}
    .lastrun-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05)}
    .lastrun-row:last-child{border-bottom:none}
    .lastrun-zone{color:var(--primary-text-color,#eee)}
    .lastrun-skipped{color:rgba(255,180,60,0.8);font-style:italic}
    .lastrun-ts{font-size:11px;color:var(--secondary-text-color,#666);margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.07)}
    .lastrun-section-lbl{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--secondary-text-color,#555);font-weight:700;margin-bottom:4px}
    .lastrun-dur{color:var(--secondary-text-color,#666);font-size:11px}
    .zprog-track{height:3px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;margin-bottom:4px}
    .zprog-fill{height:100%;width:0%;background:linear-gradient(90deg,#1a8a64,#4dc49a);border-radius:2px;transition:width .9s linear}
    .zstatus-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;min-height:14px}
    .zstat{font-size:11px;color:var(--secondary-text-color,#666);display:flex;align-items:center;gap:4px;min-height:14px}
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
    /* time picker modal */
    .time-picker-modal{display:none;position:fixed;inset:0;z-index:10002;background:rgba(0,0,0,0.85);align-items:center;justify-content:center;padding:16px}
    .time-picker-modal--open{display:flex}
    .time-picker-box{background:#1a1a1a;border:1px solid rgba(77,196,154,0.4);border-radius:16px;padding:0;overflow:hidden;width:100%;max-width:300px}
    .time-picker-hdr{display:flex;align-items:center;justify-content:space-between;padding:16px;border-bottom:1px solid rgba(77,196,154,0.2);background:linear-gradient(135deg,rgba(10,92,69,0.3),rgba(26,138,100,0.2))}
    .time-picker-title{font-size:16px;font-weight:700;color:#4dc49a}
    .time-picker-body{padding:32px 16px;display:flex;align-items:center;justify-content:center;gap:16px}
    .time-picker-spinner{display:flex;flex-direction:column;align-items:center;gap:8px}
    .time-picker-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--secondary-text-color,#555)}
    .time-picker-btn{width:44px;height:40px;border:1px solid rgba(77,196,154,0.3);background:rgba(26,138,100,0.12);color:#4dc49a;font-size:20px;font-weight:700;cursor:pointer;border-radius:8px;padding:0;transition:background .1s}
    .time-picker-btn:hover{background:rgba(26,138,100,0.25)}
    .time-picker-btn:active{transform:scale(0.95)}
    .time-picker-input{width:90px;height:70px;font-size:40px;font-weight:700;text-align:center;padding:15px 12px;border:2px solid rgba(77,196,154,0.3);background:rgba(26,138,100,0.1);color:var(--primary-text-color,#fff);border-radius:10px;-moz-appearance:textfield;outline:none;line-height:1}
    .time-picker-input::-webkit-inner-spin-button,.time-picker-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
    .time-picker-input:focus{border-color:rgba(77,196,154,0.6);background:rgba(26,138,100,0.2)}
    .time-picker-sep{font-size:40px;font-weight:700;color:var(--primary-text-color,#eee);line-height:1}
    .time-picker-footer{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:16px}
    .time-picker-action-btn{padding:12px;border-radius:10px;border:none;font-size:14px;font-weight:700;cursor:pointer;transition:opacity .15s}
    .time-picker-cancel{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:var(--secondary-text-color,#aaa)}
    .time-picker-cancel:hover{background:rgba(255,255,255,0.12)}
    .time-picker-save{background:linear-gradient(135deg,#0a5c45,#1a8a64);color:#fff}
    .time-picker-save:hover{opacity:.9}
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
        <button class="hbtn hbtn--start" id="btn-start">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>Start Schedule
        </button>
        <button class="hbtn hbtn--stop-sched" id="btn-stop-sched" style="display:none">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>Stop Schedule
        </button>
        <button class="hbtn hbtn--lastrun" id="btn-lastrun">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Last Run
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
    <div class="lastrun-modal" id="lastrun-modal">
      <div class="lastrun-box">
        <div class="lastrun-hdr">
          <h3>🕐 Last Run</h3>
          <button class="lastrun-close-btn" id="lastrun-close">Close</button>
        </div>
        <div class="lastrun-body" id="lastrun-body">No run recorded yet.</div>
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
          <li>Settings: min 0, max 60, step 1, unit <b>min</b></li>
          <li>Add up to <code>valve_10_time</code> if using more than 8 zones</li>
        </ul>

        <h4>Step 3 — Install Scheduler integration</h4>
        <p>Install <b>Scheduler Component</b> via HACS (Integration category). That's all — on first load (as an admin user) the card creates <code>script.sprinkler</code>, the scheduler entity, one <code>timer.sprinkler_zone_N</code> per zone, and <code>automation.sprinkler_controller</code>. The scheduler defaults to Mon/Wed/Fri at 06:00 — adjust the days and time using the Schedule section on the card.</p>

        <h4>How watering is controlled</h4>
        <p>All timing runs inside Home Assistant, not in the browser. Every zone gets a restoring HA timer: whenever a zone turns on — from the schedule, Manual Run, the zone toggle, the eWeLink app or another automation — the controller automation arms its timer and closes the valve when it runs out. Scheduled runs are kept in <code>input_text.sprinkler_queue</code>, so if HA restarts mid-run the current zone finishes on time and the remaining zones continue. Closing the dashboard never leaves a zone running.</p>

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
    <div class="time-picker-modal" id="time-picker-modal">
      <div class="time-picker-box">
        <div class="time-picker-hdr">
          <span class="time-picker-title">Schedule Time</span>
          <span style="font-size:11px;color:var(--secondary-text-color,#666)">24h format</span>
        </div>
        <div class="time-picker-body">
          <div class="time-picker-spinner">
            <div class="time-picker-label">Hour</div>
            <button class="time-picker-btn" id="hour-up">▲</button>
            <input type="number" class="time-picker-input" id="hour-input" min="0" max="23">
            <button class="time-picker-btn" id="hour-down">▼</button>
          </div>
          <div class="time-picker-sep">:</div>
          <div class="time-picker-spinner">
            <div class="time-picker-label">Minute</div>
            <button class="time-picker-btn" id="min-up">▲</button>
            <input type="number" class="time-picker-input" id="min-input" min="0" max="59">
            <button class="time-picker-btn" id="min-down">▼</button>
          </div>
        </div>
        <div class="time-picker-footer">
          <button class="time-picker-action-btn time-picker-cancel" id="time-picker-cancel">Cancel</button>
          <button class="time-picker-action-btn time-picker-save" id="time-picker-save">✓ Save</button>
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
    r.getElementById('btn-start').addEventListener('click', () => this._startSchedule());
    r.getElementById('btn-stop-sched').addEventListener('click', () => this._stopSchedule());
    r.getElementById('btn-lastrun').addEventListener('click', () => this._showLastRun());
    r.getElementById('lastrun-close').addEventListener('click', () => {
      r.getElementById('lastrun-modal').classList.remove('lastrun-modal--open');
    });
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
      if (this._editingTime) return;
      this._editingTime = true;
      const cur = timeEl.textContent.trim() || '06:00';
      const [curH, curM] = cur.split(':').map(Number);
      
      const modal = r.getElementById('time-picker-modal');
      const hInp = r.getElementById('hour-input');
      const mInp = r.getElementById('min-input');
      
      hInp.value = String(curH).padStart(2,'0');
      mInp.value = String(curM).padStart(2,'0');
      
      modal.classList.add('time-picker-modal--open');
      setTimeout(() => hInp.focus(), 100);
      
      const updateHour = (delta) => {
        let v = Math.min(23, Math.max(0, parseInt(hInp.value||0) + delta));
        hInp.value = String(v).padStart(2,'0');
      };
      const updateMin = (delta) => {
        let v = Math.min(59, Math.max(0, parseInt(mInp.value||0) + delta));
        mInp.value = String(v).padStart(2,'0');
      };
      
      const save = () => {
        this._editingTime = false;
        modal.classList.remove('time-picker-modal--open');
        const h = Math.min(23, Math.max(0, parseInt(hInp.value)||0));
        const m = Math.min(59, Math.max(0, parseInt(mInp.value)||0));
        const val = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
        timeEl.textContent = val;
        if (val !== cur) this._saveTime(val);
      };
      const cancel = () => {
        this._editingTime = false;
        modal.classList.remove('time-picker-modal--open');
      };
      
      r.getElementById('hour-up').onclick = () => updateHour(1);
      r.getElementById('hour-down').onclick = () => updateHour(-1);
      r.getElementById('min-up').onclick = () => updateMin(1);
      r.getElementById('min-down').onclick = () => updateMin(-1);
      r.getElementById('time-picker-save').onclick = save;
      r.getElementById('time-picker-cancel').onclick = cancel;
      
      hInp.onchange = mInp.onchange = () => {};
      mInp.addEventListener('input', ()=>{let v=parseInt(mInp.value)||0;if(v>59)mInp.value='59';});
      hInp.addEventListener('input', ()=>{let v=parseInt(hInp.value)||0;if(v>23)hInp.value='23';});
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
      const tog=document.createElement('div'); tog.className='ztoggle'; tog.id='ztog-'+i; tog.title='On/off — auto-stops after the zone duration';
      tog.appendChild(Object.assign(document.createElement('div'),{className:'ztoggle-thumb'}));
      top.append(seq,name,skip,tog);
      const pt=document.createElement('div'); pt.className='zprog-track';
      const pf=document.createElement('div'); pf.className='zprog-fill'; pf.id='zprog-'+i; pt.appendChild(pf);
      const stat=document.createElement('div'); stat.className='zstat'; stat.id='zstat-'+i; stat.textContent='Ready';
      const zlast=document.createElement('div'); zlast.className='zlast'; zlast.id='zlast-'+i;
      const statusRow=document.createElement('div'); statusRow.className='zstatus-row'; statusRow.append(stat,zlast);
      const dv=document.createElement('div'); dv.className='zdivider';
      const dr=document.createElement('div'); dr.className='zdur-row';
      const dl=document.createElement('span'); dl.className='zdur-lbl'; dl.textContent='Min';
      const di=document.createElement('input'); di.type='number'; di.className='zdur-input';
      di.id='zdur-'+i; di.min=0; di.max=60; di.step=1; di.value=z.dur?parseFloat(this._hass.states[z.dur]?.state||10):10;
      const du=document.createElement('span'); du.className='zdur-unit'; du.textContent='min';
      const db=document.createElement('div'); db.className='zdur-btns';
      const bm=document.createElement('button'); bm.className='zdur-btn'; bm.textContent='-';
      const bp=document.createElement('button'); bp.className='zdur-btn'; bp.textContent='+';
      db.append(bm,bp); dr.append(dl,di,du,db);
      el.append(top,pt,statusRow,dv,dr); grid.appendChild(el);
      
      // Click zone card to expand details
      el.addEventListener('click', (ev) => {
        if (ev.target.tagName === 'BUTTON' || ev.target.tagName === 'INPUT' || ev.target.closest('.zskip') || ev.target.closest('.ztoggle')) return;
        this._showZoneDetails(i, z);
      });
      
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
      const applyDur=(val)=>{ val=Math.min(60,Math.max(0,val)); di.value=val; if(z.dur)this._svc('input_number','set_value',{entity_id:z.dur,value:val}); };
      di.addEventListener('change',()=>applyDur(parseFloat(di.value)||0));
      bm.addEventListener('click',()=>applyDur((parseFloat(di.value)||0)-1));
      bp.addEventListener('click',()=>applyDur((parseFloat(di.value)||0)+1));
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

    // rain restore hours
    const rrRow=document.createElement('div'); rrRow.className='cfg-field-row';
    const rrLbl=document.createElement('label'); rrLbl.className='cfg-field-lbl'; rrLbl.textContent='Rain restore';
    const rrInp=document.createElement('input'); rrInp.type='number'; rrInp.className='cfg-field-input';
    rrInp.value=this._cfg.rain_restore_hours||48; rrInp.placeholder='48'; rrInp.min=1; rrInp.max=168;
    rrInp.dataset.cfgKey='rain_restore_hours';
    const rrHint=document.createElement('span'); rrHint.style.cssText='font-size:9px;color:var(--secondary-text-color,#666);flex-shrink:0'; rrHint.textContent='h → re-enable sched';
    rrRow.append(rrLbl,rrInp,rrHint); slist.appendChild(rrRow);

    // jojo low %
    const jlRow=document.createElement('div'); jlRow.className='cfg-field-row';
    const jlLbl=document.createElement('label'); jlLbl.className='cfg-field-lbl'; jlLbl.textContent='Jojo low %';
    const jlInp=document.createElement('input'); jlInp.type='number'; jlInp.className='cfg-field-input';
    jlInp.value=this._cfg.jojo_low_pct||35; jlInp.placeholder='35'; jlInp.min=0; jlInp.max=100;
    jlInp.dataset.cfgKey='jojo_low_pct';
    const jlHint=document.createElement('span'); jlHint.style.cssText='font-size:9px;color:var(--secondary-text-color,#666);flex-shrink:0'; jlHint.textContent='% → shut off zones';
    jlRow.append(jlLbl,jlInp,jlHint); slist.appendChild(jlRow);

    // number fields save as soon as they change — the controller automation is rebuilt from them
    [[rtInp,'rain_threshold',5],[rrInp,'rain_restore_hours',48],[jlInp,'jojo_low_pct',35]].forEach(([inp,key,def])=>{
      inp.addEventListener('change',()=>{
        const v=parseFloat(inp.value);
        if (isNaN(v)) { inp.value=this._cfg[key]??def; return; }
        if (v===this._cfg[key]) return;
        this._saveConfig({[key]:v});
        this._updateRuleDescriptions();
        this._update();
      });
    });

    // notify service for tank-low / stuck-valve alerts (e.g. notify.whatsapp, notify.mobile_app_phone)
    const ntRow=document.createElement('div'); ntRow.className='cfg-field-row';
    const ntLbl=document.createElement('label'); ntLbl.className='cfg-field-lbl'; ntLbl.textContent='Notify';
    const ntInp=document.createElement('input'); ntInp.type='text'; ntInp.className='cfg-field-input';
    ntInp.value=this._cfg.notify_service||''; ntInp.placeholder='notify.mobile_app_phone (optional)';
    ntInp.addEventListener('change',()=>{
      const v=ntInp.value.trim();
      if (v && !/^notify\.[a-z0-9_]+$/.test(v)) { ntInp.style.borderColor='#c23030'; return; }
      ntInp.style.borderColor='';
      this._saveConfig({notify_service:v});
    });
    ntRow.append(ntLbl,ntInp); slist.appendChild(ntRow);

    // entity fields
    [{label:'Rain sensor',key:'rain_sensor',val:this._cfg.rain_sensor||''},{label:'Weather',key:'weather_entity',val:this._cfg.weather_entity||''},{label:'Jojo sensor',key:'jojo_sensor',val:this._cfg.jojo_sensor||''},{label:'Jojo level %',key:'jojo_level_sensor',val:this._cfg.jojo_level_sensor||''},{label:'Schedule sw',key:'schedule_entity',val:this._cfg.schedule_entity||''}]
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
        key:'rain_auto_restore',
        title:'Rain: Auto-restore schedule',
        desc:`After rain disables the schedule, automatically re-enable it after ${this._cfg.rain_restore_hours||48}h (configurable above in Rain restore).`,
      },
      {
        key:'jojo_shutoff_zones',
        title:'Jojo: Low-level zone shutoff',
        desc:`If tank level drops below ${this._cfg.jojo_low_pct||35}%, all running zones are switched off and scheduled runs are cancelled. Runs in HA even with no dashboard open.`,
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

    // ── Version footer ──
    const verFooter=document.createElement('div'); 
    verFooter.style.cssText='margin-top:20px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.1);text-align:center;font-size:10px;color:var(--secondary-text-color,#888)';
    verFooter.textContent='Sprinkler Dash Card v'+CARD_VERSION;
    body.appendChild(verFooter);
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
    const rrEl=panel.querySelector('[data-cfg-key="rain_restore_hours"]');
    if (rrEl) this._cfg.rain_restore_hours=parseFloat(rrEl.value)||48;
    const jlEl=panel.querySelector('[data-cfg-key="jojo_low_pct"]');
    if (jlEl) this._cfg.jojo_low_pct=parseFloat(jlEl.value)||35;

    // update rule descriptions to reflect current values
    this._updateRuleDescriptions();
    // thresholds / zone names feed the server-side controller
    this._scheduleEngineRebuild();

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

  _updateRuleDescriptions() {
    const panel = this.shadowRoot.getElementById('cfg-panel');
    if (!panel) return;
    
    const rules = this._cfg.rules || {};
    const ruleDefs = [
      {
        key:'confirm_actions',
        desc:'Show a confirmation popup before turning zones on/off, All Off, Start Schedule, and schedule toggle.'
      },
      {
        key:'rain_disable_schedule',
        desc:`If rain sensor exceeds ${this._cfg.rain_threshold||5}mm, the schedule switch is automatically turned off. Rain value turns yellow in info bar.`
      },
      {
        key:'rain_auto_restore',
        desc:`After rain disables the schedule, automatically re-enable it after ${this._cfg.rain_restore_hours||48}h (configurable above in Rain restore).`
      },
      {
        key:'jojo_shutoff_zones',
        desc:`If tank level drops below ${this._cfg.jojo_low_pct||35}%, all running zones are switched off and scheduled runs are cancelled. Runs in HA even with no dashboard open.`
      }
    ];
    
    ruleDefs.forEach(def => {
      const ruleEl = Array.from(panel.querySelectorAll('.rule-desc')).find(el => el.textContent.includes(def.key.replace(/_/g,' ')) || el.textContent.includes(def.desc.split(' ')[0]));
      if (ruleEl) ruleEl.textContent = def.desc;
    });
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

  _stopSchedule() {
    this._confirm('Stop Schedule', 'Stop the running schedule and close all valves?', 'confirm-btn--danger').then(ok => {
      if (!ok) return;
      // clear the queue first so closing the valves does not advance to the next zone
      this._clearQueue();
      this._svc('script', 'turn_off', {entity_id: 'script.sprinkler'});
      const allSwitches = this._zoneSwitches();
      if (allSwitches.length) this._svc('switch', 'turn_off', {entity_id: allSwitches});
    });
  }

  _showZoneDetails(idx, z) {
    const modal = document.createElement('div');
    modal.className = 'zone-detail-modal zone-detail-modal--open';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000';

    const content = document.createElement('div');
    content.style.cssText = 'background:#222;border-radius:12px;padding:20px;max-width:450px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.8);color:#fff;font-family:system-ui,-apple-system,sans-serif';

    const title = document.createElement('h2');
    title.style.cssText = 'margin:0 0 15px 0;font-size:22px;color:#4dc49a;text-align:center';
    title.textContent = z.name;

    const sw = this._hass.states[z.sw];
    const isOn = sw?.state === 'on';
    const scheduledDur = z.dur ? Math.round(parseFloat(this._hass.states[z.dur]?.state || 10)) : 10;
    let currentDur = Math.max(1, scheduledDur);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:13px;margin-bottom:12px;padding:10px;background:rgba(77,196,154,0.1);border-radius:6px;text-align:center';
    let statusTxt = isOn ? '🟢 ON' : (sw?.state === 'unavailable' ? '⚠️ UNAVAILABLE' : '⚪ OFF');
    const tLeft = this._timerRemaining(idx);
    if (isOn && tLeft !== null) statusTxt += ' · auto-off in ' + Math.floor(tLeft/60) + 'm ' + String(Math.round(tLeft%60)).padStart(2,'0') + 's';
    status.innerHTML = '<strong>Status:</strong> ' + statusTxt;

    // Duration for THIS manual run only — the scheduled duration helper is not touched
    const durSection = document.createElement('div');
    durSection.style.cssText = 'margin:15px 0;padding:15px;background:rgba(77,196,154,0.08);border-radius:8px;text-align:center';

    const durLabel = document.createElement('div');
    durLabel.style.cssText = 'font-size:12px;color:var(--secondary-text-color,#999);margin-bottom:10px;text-transform:uppercase;font-weight:600;letter-spacing:1px';
    durLabel.textContent = 'Manual run duration';

    const durDisplay = document.createElement('div');
    durDisplay.style.cssText = 'font-size:42px;font-weight:700;color:#4dc49a;margin:10px 0;font-family:monospace';
    durDisplay.textContent = currentDur;

    const durUnit = document.createElement('div');
    durUnit.style.cssText = 'font-size:14px;color:var(--secondary-text-color,#999);margin-bottom:12px';
    durUnit.textContent = 'minutes (scheduled: ' + scheduledDur + ')';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center';

    const minusBtn = document.createElement('button');
    minusBtn.style.cssText = 'width:50px;height:50px;border-radius:8px;border:none;background:#c23030;color:#fff;font-size:28px;font-weight:bold;cursor:pointer;transition:background 0.2s';
    minusBtn.textContent = '−';
    minusBtn.addEventListener('click', () => { currentDur = Math.max(1, currentDur - 1); durDisplay.textContent = currentDur; });

    const plusBtn = document.createElement('button');
    plusBtn.style.cssText = 'width:50px;height:50px;border-radius:8px;border:none;background:#4dc49a;color:#1a1a1a;font-size:28px;font-weight:bold;cursor:pointer;transition:background 0.2s';
    plusBtn.textContent = '+';
    plusBtn.addEventListener('click', () => { currentDur = Math.min(60, currentDur + 1); durDisplay.textContent = currentDur; });

    btnRow.append(minusBtn, plusBtn);
    durSection.append(durLabel, durDisplay, durUnit, btnRow);

    const lastRun = document.createElement('div');
    lastRun.style.cssText = 'font-size:12px;margin-bottom:15px;padding:10px;background:rgba(77,196,154,0.1);border-radius:6px';
    const lastChanged = sw?.last_changed ? new Date(sw.last_changed).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) : 'unknown';
    lastRun.innerHTML = '<strong>Last Activity:</strong> ' + lastChanged;

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:10px;margin-top:15px';

    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'flex:1;padding:10px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:6px;cursor:pointer;font-weight:600;font-size:14px';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => modal.remove());

    const toggleBtn = document.createElement('button');
    toggleBtn.style.cssText = 'flex:1;padding:10px;background:'+(isOn ? '#c23030' : '#4dc49a')+';border:none;color:'+(isOn ? '#fff' : '#1a1a1a')+';border-radius:6px;cursor:pointer;font-weight:700;font-size:14px';
    toggleBtn.textContent = isOn ? 'Turn Off' : 'Manual Run';
    toggleBtn.addEventListener('click', () => {
      if (!z.sw) return;
      if (isOn) this._svc('switch', 'turn_off', {entity_id: z.sw});
      else this._manualZoneRun(idx, z, currentDur);
      modal.remove();
    });
    if (isOn) durSection.style.display = 'none';

    buttons.append(closeBtn, toggleBtn);
    content.append(title, status, durSection, lastRun, buttons);
    modal.append(content);
    modal.addEventListener('click', (ev) => { if (ev.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }

  // seconds left on a zone's server-side timer, or null if it is not running
  _timerRemaining(idx) {
    const t = this._hass?.states[zoneTimer(idx)];
    if (!t || t.state !== 'active' || !t.attributes?.finishes_at) return null;
    return Math.max(0, (new Date(t.attributes.finishes_at).getTime() - Date.now()) / 1000);
  }

  // Manual log: newest-first array of {z:name, d:minutes, t:epoch-seconds}, trimmed to fit 255 chars
  _persistManualLog() {
    if (!this._hass.states[MANUAL_LOG_E]) return;
    const log = this._manualRunLog.slice(0, 6);
    let data = JSON.stringify(log);
    while (data.length > 255 && log.length) { log.pop(); data = JSON.stringify(log); }
    this._svc('input_text', 'set_value', {entity_id: MANUAL_LOG_E, value: data});
  }

  _loadManualLog() {
    const raw = this._hass?.states[MANUAL_LOG_E]?.state;
    if (!raw || raw === 'unknown' || raw === 'unavailable') return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this._manualRunLog = parsed.filter(e => e && e.z);
      else if (parsed && typeof parsed === 'object') {
        // pre-3.0 format: { "switch.x": {zone, duration, timestamp} }
        this._manualRunLog = Object.values(parsed).filter(e => e && e.zone)
          .map(e => ({ z: e.zone, d: e.duration, t: Math.round(new Date(e.timestamp).getTime()/1000) }))
          .sort((a,b) => b.t - a.t);
      }
    } catch(err) { /* ignore malformed data */ }
  }

  // Timer first, then the valve: the controller sees an active timer and keeps
  // this custom duration. The timer lives in HA, so closing the browser, changing
  // views or restarting HA no longer leaves the zone running.
  async _manualZoneRun(idx, z, mins) {
    if (!z.sw) return;
    mins = Math.max(1, Math.min(60, Math.round(mins)));
    const t = zoneTimer(idx);
    try {
      if (this._hass.states[t]) await this._hass.callService('timer', 'start', { entity_id: t, duration: hhmm00(mins) });
      else console.warn('[SprinklerCard] '+t+' missing — zone will use its scheduled duration');
      await this._hass.callService('switch', 'turn_on', { entity_id: z.sw });
    } catch(e) {
      console.error('[SprinklerCard] manual run failed', e);
      return;
    }
    this._manualRunLog = [{ z: z.name, d: mins, t: Math.round(Date.now()/1000) }, ...this._manualRunLog.filter(e => e.z !== z.name)];
    this._persistManualLog();
    console.log('[SprinklerCard] Manual run started: '+z.name+' for '+mins+'min (auto-off handled by HA timer '+t+')');
  }

  // total seconds each switch was "on" between start and end, from HA history
  async _onSeconds(entityIds, startMs, endMs) {
    const out = {};
    const hist = await this._hass.callWS({
      type: 'history/history_during_period',
      start_time: new Date(startMs).toISOString(),
      end_time: new Date(endMs).toISOString(),
      entity_ids: entityIds,
      minimal_response: true, no_attributes: true, significant_changes_only: false,
    });
    for (const id of entityIds) {
      const rows = hist?.[id] || [];
      let secs = 0, onSince = null;
      rows.forEach(r => {
        const ts = ((r.lc ?? r.lu) || 0) * 1000;
        const at = Math.max(ts, startMs);
        if (r.s === 'on') { if (onSince === null) onSince = at; }
        else if (onSince !== null) { secs += (at - onSince) / 1000; onSince = null; }
      });
      if (onSince !== null) secs += (endMs - onSince) / 1000;
      out[id] = secs;
    }
    return out;
  }

  async _showLastRun() {
    const r = this.shadowRoot;
    const body = r.getElementById('lastrun-body');
    r.getElementById('lastrun-modal').classList.add('lastrun-modal--open');

    const lastTriggered = this._hass.states['script.sprinkler']?.attributes?.last_triggered;
    const allZones = this._activeZones().filter(z => z.sw);
    const fmtDur = (s) => { s = Math.round(s); const m = Math.floor(s/60), sec = s%60; return m + 'm' + (sec ? ' ' + String(sec).padStart(2,'0') + 's' : ''); };

    let html = '';
    if (!lastTriggered) {
      html += '<p style="color:var(--secondary-text-color,#666)">⏳ No scheduled run found. Run the schedule to populate this view.</p>';
    } else if (!allZones.length) {
      html += '<p style="color:var(--secondary-text-color,#666);margin-top:10px">No zones configured.</p>';
    } else {
      body.innerHTML = '<p style="color:var(--secondary-text-color,#666)">Loading run history…</p>';
      const runStart = new Date(lastTriggered).getTime();
      const windowStart = runStart - 2*60*1000;
      const windowEnd = Math.min(Date.now(), runStart + 6*60*60*1000);
      const ts = new Date(lastTriggered).toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
      html += '<div class="lastrun-ts">📅 ' + ts + (this._isRunActive() ? ' · <span style="color:#4dc49a">in progress</span>' : '') + '</div>';

      let onSecs = null;
      try { onSecs = await this._onSeconds(allZones.map(z=>z.sw), windowStart, windowEnd); }
      catch(e) { console.warn('[SprinklerCard] history lookup failed', e); }

      const queued = this._queuedZoneNums();
      const skipList = this._skipList();
      const ran = [], waiting = [], skipped = [], missing = [];
      allZones.forEach(z => {
        const idx = this._activeZones().indexOf(z);
        const secs = onSecs ? (onSecs[z.sw] || 0) : null;
        if (secs !== null && secs >= 20) ran.push({ z, secs });
        else if (queued.includes(idx+1)) waiting.push(z);
        else if (skipList.includes(z.sw) || z.schedule_enabled === false) skipped.push(z);
        else missing.push(z);
      });

      if (onSecs === null) html += '<p style="color:#ffb43c">Could not read history from Home Assistant.</p>';
      if (ran.length) {
        html += '<div class="lastrun-section-lbl">Watered (' + ran.length + ')</div>';
        ran.forEach(({z, secs}) => {
          const planned = z.dur ? parseFloat(this._hass.states[z.dur]?.state || 0) : 0;
          const short = planned && secs < planned*60 - 60;
          html += '<div class="lastrun-row"><span class="lastrun-zone">💧 ' + z.name + '</span>' +
            '<span class="lastrun-dur" style="font-size:11px;color:' + (short ? '#ffb43c' : 'var(--secondary-text-color,#999)') + '">' +
            fmtDur(secs) + (short ? ' of ' + planned + 'm' : '') + '</span></div>';
        });
      } else if (onSecs !== null) {
        html += '<p style="color:var(--secondary-text-color,#666);margin-top:4px">No zones watered in this run window.</p>';
      }
      if (waiting.length) {
        html += '<div class="lastrun-section-lbl" style="margin-top:10px">Still queued (' + waiting.length + ')</div>';
        waiting.forEach(z => { html += '<div class="lastrun-row"><span class="lastrun-zone">⏳ ' + z.name + '</span><span class="lastrun-dur">—</span></div>'; });
      }
      if (skipped.length) {
        html += '<div class="lastrun-section-lbl" style="margin-top:10px">Skipped / not scheduled (' + skipped.length + ')</div>';
        skipped.forEach(z => { html += '<div class="lastrun-row"><span class="lastrun-skipped">⏭ ' + z.name + '</span><span class="lastrun-dur">—</span></div>'; });
      }
      if (missing.length) {
        html += '<div class="lastrun-section-lbl" style="margin-top:10px">Did not run (' + missing.length + ')</div>';
        missing.forEach(z => {
          const sw = this._hass.states[z.sw];
          const why = sw?.state === 'unavailable' ? 'unavailable' : (sw?.last_changed ? 'last ' + this._formatTimeAgo(new Date(sw.last_changed)) : 'never');
          html += '<div class="lastrun-row"><span class="lastrun-skipped">⚪ ' + z.name + '</span><span class="lastrun-dur" style="font-size:11px">' + why + '</span></div>';
        });
      }
    }

    if (this._manualRunLog.length) {
      html += '<div class="lastrun-section-lbl" style="margin-top:12px;opacity:0.8;font-size:11px">MANUAL RUNS</div>';
      this._manualRunLog.forEach(e => {
        html += '<div class="lastrun-row"><span class="lastrun-zone">🔧 ' + e.z + '</span>' +
          '<span class="lastrun-dur" style="font-size:11px;color:var(--secondary-text-color,#999)">' + e.d + 'm • ' + this._formatTimeAgo(new Date(e.t*1000)) + '</span></div>';
      });
    }
    body.innerHTML = html;
  }

  _formatTimeAgo(date) {
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMin / 60);
    
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return diffMin + 'm ago';
    if (diffHour < 24) return diffHour + 'h ago';
    return Math.floor(diffHour / 24) + 'd ago';
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
            if (numVal>=rainThresh && this._cfg.rules?.rain_disable_schedule!==false) warn=true;
          }
          if (s2 && slot.sensor2.includes('liquid_level')) {
            const pct=parseFloat(s2.state);
            if (pct<jojoLow && this._cfg.rules?.jojo_shutoff_zones!==false) {
              warn=true;
              it.title='Tank below '+jojoLow+'% — scheduled runs blocked';
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
    const queued=this._queuedZoneNums();
    this._activeZones().forEach((z,i)=>{
      const swState=z.sw?this._hass.states[z.sw]:null;
      const isOn=swState?.state==='on';
      const durVal=z.dur?parseFloat(this._hass.states[z.dur]?.state||10):10;
      const durMin=z.dur?parseFloat(this._hass.states[z.dur]?.attributes?.min??0):0;
      const durMax=z.dur?parseFloat(this._hass.states[z.dur]?.attributes?.max??60):60;
      if(isOn) active++;
      const root=this.shadowRoot.getElementById('zone-'+i);
      root?.classList.toggle('zone--on',isOn);
      root?.classList.toggle('zone--disabled', z.schedule_enabled===false);
      const skipped = this._isZoneSkipped(z);
      root?.classList.toggle('zone--skip', skipped && !isOn);
      this.shadowRoot.getElementById('zskip-'+i)?.classList.toggle('zskip--active', skipped);
      const skipEl = this.shadowRoot.getElementById('zskip-'+i);
      if (skipEl) skipEl.title = skipped ? 'Skipped — tap to cancel' : 'Skip next scheduled run';
      this.shadowRoot.getElementById('zseq-'+i)?.classList.toggle('zseq--on',isOn);
      this.shadowRoot.getElementById('ztog-'+i)?.classList.toggle('ztoggle--on',isOn);
      const inp=this.shadowRoot.getElementById('zdur-'+i);
      if(inp&&inp!==this.shadowRoot.activeElement){inp.min=durMin;inp.max=durMax;inp.value=durVal;}
      this._renderZoneProgress(i, z, queued);
      // last-changed badge
      const zlastEl = this.shadowRoot.getElementById('zlast-'+i);
      if (zlastEl && !isOn && z.sw) {
        const lc = swState?.last_changed;
        if (swState?.state==='unavailable') { zlastEl.textContent='unavailable'; zlastEl.className='zlast'; zlastEl.style.color='#ffb43c'; }
        else if (lc) {
          zlastEl.style.color='';
          const mins = Math.round((Date.now() - new Date(lc).getTime()) / 60000);
          if (mins < 60) { zlastEl.textContent='last: '+mins+'m ago'; zlastEl.className='zlast zlast--recent'; }
          else if (mins < 1440) { zlastEl.textContent='last: '+Math.floor(mins/60)+'h ago'; zlastEl.className='zlast'; }
          else { zlastEl.textContent='last: '+Math.floor(mins/1440)+'d ago'; zlastEl.className='zlast'; }
        } else { zlastEl.textContent=''; }
      } else if (zlastEl && isOn) { zlastEl.textContent=''; }
    });
    const badge=this.shadowRoot.getElementById('hdr-badge');
    if(badge){
      let txt=this._cfg.active_zones+' zones';
      if(active>0) txt=active+' watering'+(queued.length?' · '+queued.length+' queued':'');
      else if(queued.length) txt=queued.length+' queued';
      badge.textContent=txt; badge.className='badge'+(active>0||queued.length?' badge--active':'');
    }
  }

  // Progress/countdown comes from the zone's HA timer, so it is correct after a
  // page reload or HA restart and matches exactly when the valve will close.
  _renderZoneProgress(i, z, queued) {
    const isOn = z.sw && this._hass.states[z.sw]?.state==='on';
    const t = this._hass.states[zoneTimer(i)];
    let total = 0, rem = null;
    if (isOn && t?.state==='active' && t.attributes?.finishes_at) {
      total = durToSecs(t.attributes.duration);
      rem = Math.max(0, (new Date(t.attributes.finishes_at).getTime() - Date.now())/1000);
    }
    const qpos = (queued||this._queuedZoneNums()).indexOf(i+1);
    this._renderProgress(i, isOn, total && rem!==null ? total-rem : 0, total, this._isZoneSkipped(z), rem, qpos);
  }

  _updateSchedule() {
    if(!this._built)return;
    const e=this._cfg.schedule_entity; if(!e||!this._hass.states[e])return;
    const ent=this._hass.states[e], isOn=ent.state==='on'||ent.state==='triggered', attrs=ent.attributes||{};
    const tog=this.shadowRoot.getElementById('sched-toggle'); if(tog)tog.className='stoggle'+(isOn?' stoggle--on':'');
    this._days.forEach(d=>{ const el=this.shadowRoot.getElementById('sday-'+d); if(el)el.className='sday'+((attrs.weekdays||[]).includes(d)?' sday--on':''); });
    const timeEl=this.shadowRoot.getElementById('sched-time');
    if(timeEl&&!this._editingTime){ const t=(attrs.timeslots||[])[0]||''; timeEl.textContent=(typeof t==='string'?t:(t.start||'')).substring(0,5)||'--:--'; }
    const nextEl=this.shadowRoot.getElementById('sched-next');
    if(!nextEl) return;
    // rain pause set by the controller automation
    const rp=this._hass.states[RAIN_PAUSE_E]?.state||'';
    const rpMs=Date.parse(rp);
    if(!isOn && rp && !isNaN(rpMs)){
      if(this._cfg.rules?.rain_auto_restore===false){ nextEl.textContent='paused by rain 🌧'; }
      else {
        const left=rpMs+(parseFloat(this._cfg.rain_restore_hours)||48)*3600000-Date.now();
        if(left>0){ const h=Math.floor(left/3600000),m=Math.floor((left%3600000)/60000); nextEl.textContent='rain pause · resumes in '+h+'h '+m+'m 🌧'; }
        else nextEl.textContent='rain pause · resumes when dry 🌤';
      }
      nextEl.className='sched-next'; nextEl.style.color='#ffcc44';
      return;
    }
    nextEl.style.color='';
    if(!attrs.next_trigger){ nextEl.textContent=isOn?'—':'disabled'; nextEl.className='sched-next'; return; }
    const d=new Date(attrs.next_trigger),now=new Date(),diff=d-now;
    const h=Math.floor(diff/3600000),m=Math.floor((diff%3600000)/60000);
    const timeStr=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});
    const tomorrowDate=new Date(now.getTime()+86400000).toDateString();
    let label;
    if(diff<0) label='overdue';
    else if(h<1) label='in '+m+'m';
    else if(h<24) label='in '+h+'h '+(m>0?m+'m':'');
    else if(d.toDateString()===tomorrowDate) label='Tomorrow '+timeStr;
    else label=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]+' '+timeStr;
    nextEl.textContent=isOn?'next: '+label:'disabled';
    nextEl.className='sched-next'+(isOn?' sched-next--on':'');
  }

  _renderProgress(i,isOn,elapsed,total,skipped,rem=null,qpos=-1){
    const prog=this.shadowRoot.getElementById('zprog-'+i), stat=this.shadowRoot.getElementById('zstat-'+i);
    if(!prog||!stat)return;
    if(!isOn){
      prog.style.width='0%';
      if (qpos>=0) { stat.className='zstat zstat--on'; stat.textContent=qpos===0?'Up next':'Queued #'+(qpos+1); }
      else if (skipped) { stat.className='zstat zstat--skip'; stat.textContent='Skip next run'; }
      else { stat.className='zstat'; stat.textContent='Ready'; }
      return;
    }
    stat.className='zstat zstat--on'; stat.innerHTML='';
    const dot=document.createElement('span'); dot.className='pulse'; stat.appendChild(dot);
    if (rem===null || !total) {
      // on, but no timer armed yet (controller arms it within seconds)
      prog.style.width='100%';
      stat.appendChild(document.createTextNode(' Watering'));
      return;
    }
    prog.style.width=Math.min(100,(elapsed/total)*100).toFixed(2)+'%';
    const r=Math.max(0,Math.round(rem)),m=Math.floor(r/60),s=r%60;
    stat.appendChild(document.createTextNode(' '+m+'m '+String(s).padStart(2,'0')+'s left'));
  }

  _tick(){
    if(!this._hass||!this._built)return;
    const queued=this._queuedZoneNums();
    this._activeZones().forEach((z,i)=>this._renderZoneProgress(i, z, queued));
    this._updateSchedule();
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
