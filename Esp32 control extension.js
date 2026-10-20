// ESP32 Blocks - TurboWarp extension (WebSocket backend)
// Load via TurboWarp: Add Extension -> Custom Extension -> Load from file
// Talks to the ESP32 firmware in esp32_firmware.ino over a WebSocket (default port 81).
//
// Protocol (plain text, args are URL-encoded and separated by "|"):
//   Extension -> ESP32 :  COMMAND|arg1|arg2|...
//   ESP32 -> Extension :  KEY|value|...   (sensor / event updates)
(function (Scratch) {
  'use strict';

  const T = Scratch.ArgumentType;
  const B = Scratch.BlockType;

  // Number-only input (pins, values) - empty by default
  const pin = (def) => ({ type: T.NUMBER, defaultValue: def === undefined ? '' : def });
  // Free text input
  const txt = (def) => ({ type: T.STRING, defaultValue: def === undefined ? '' : def });
  const num = (def) => ({ type: T.NUMBER, defaultValue: def });
  const str = (def) => ({ type: T.STRING, defaultValue: def });
  const color = { type: T.COLOR, defaultValue: '#ff0000' };

  // Extension logo: a blue microchip with pins and a wifi symbol
  const ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
    '<rect width="40" height="40" rx="6" fill="#3B82F6"/>' +
    '<g stroke="#fff" stroke-width="2" stroke-linecap="round">' +
    '<path d="M13 5v5M20 5v5M27 5v5M13 30v5M20 30v5M27 30v5M5 13h5M5 20h5M5 27h5M30 13h5M30 20h5M30 27h5"/>' +
    '</g>' +
    '<rect x="10" y="10" width="20" height="20" rx="3" fill="#1D4ED8" stroke="#fff" stroke-width="2"/>' +
    '<g fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round">' +
    '<path d="M14.5 19a8 8 0 0 1 11 0"/>' +
    '<path d="M17 22a4.5 4.5 0 0 1 6 0"/>' +
    '</g>' +
    '<circle cx="20" cy="25.5" r="1.4" fill="#fff"/>' +
    '</svg>';
  const ICON_URI = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(ICON_SVG);

  // ---------------------------------------------------------------
  // Connection + state
  // ---------------------------------------------------------------
  let ws = null;

  const state = {
    connected: false,
    joyX: 0,
    joyY: 0,
    joySW: 0,
    rot: 0,
    temp: 0,
    rssi: 0,
    dist: 0,
    rfidTouching: false,
    rfidUid: '',
    rfidHat: false,
    ir: {},       // last IR code per pin
    irPulse: {},  // timestamp of last IR code per pin
    irHat: {},    // pending hat trigger per pin
    dr: {},       // digital read cache per pin
    ar: {},       // analog read cache per pin
    tc: {},       // touch read cache per pin
    distHasPrev: false,
    distEvents: [], // recent distance jumps: { t: time, d: size of the jump in cm }
    uptime: 0,
    heap: 0,
    vals: {},     // saved values
    dhtT: 0,
    dhtH: 0,
    dsT: 0,
    pir: 0,
    pirHat: false,
    mpu: { ax: 0, ay: 0, az: 0, roll: 0, pitch: 0 },
    btn: {},      // button pressed state per pin
    btnHat: {},   // pending button hat trigger per pin
    key: '',
    keyHat: false,
    i2c: '',
    servoAngle: {}, // last servo angle per pin (for slow moves)
    lost: false,        // connection dropped and not yet restored
    lostHat: false,
    restoredHat: false,
    ping: 0,
    mac: '',
    serialText: '',
    serialHat: false,
    httpCode: 0,
    httpBody: '',
    env: { temp: 0, pressure: 0, altitude: 0, humidity: 0 },
    col: { red: 0, green: 0, blue: 0 },
    gesture: '',
    gestureHats: { up: false, down: false, left: false, right: false, any: false },
    prox: 0,
    grams: 0,
    gps: { latitude: 0, longitude: 0, speed: 0, satellites: 0, altitude: 0 },
    rtc: {},
    ntp: {},
    nowFrom: '',
    nowMsg: '',
    nowHat: false,
  };
  const watched = {
    d: new Set(), a: new Set(), ir: new Set(), t: new Set(), b: new Set(), ld: new Set(),
  };
  const WATCH_CMD = { d: 'WATCHD', a: 'WATCHA', ir: 'WATCHIR', t: 'WATCHT', b: 'WATCHB' };

  function resetState() {
    state.connected = false;
    state.rfidTouching = false;
    state.distHasPrev = false;
    state.distEvents = [];
    Object.keys(watched).forEach((k) => watched[k].clear());
  }

  function send(cmd, ...args) {
    if (!ws || ws.readyState !== 1) return;
    const parts = [cmd].concat(args.map((a) => encodeURIComponent(String(a))));
    ws.send(parts.join('|'));
  }

  function handleMessage(raw) {
    const p = String(raw).split('|').map((s) => {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    });
    switch (p[0]) {
      case 'JOY':
        state.joyX = Number(p[1]) || 0;
        state.joyY = Number(p[2]) || 0;
        state.joySW = Number(p[3]) || 0;
        break;
      case 'ROT': state.rot = Number(p[1]) || 0; break;
      case 'TEMP': state.temp = Number(p[1]) || 0; break;
      case 'RSSI': state.rssi = Number(p[1]) || 0; break;
      case 'DIST': {
        const nd = Number(p[1]) || 0;
        if (state.distHasPrev) state.distEvents.push({ t: Date.now(), d: Math.abs(nd - state.dist) });
        state.dist = nd;
        state.distHasPrev = true;
        break;
      }
      case 'DR': state.dr[p[1]] = Number(p[2]) || 0; break;
      case 'AR': state.ar[p[1]] = Number(p[2]) || 0; break;
      case 'TC': state.tc[p[1]] = Number(p[2]) || 0; break;
      case 'SYS':
        state.uptime = Number(p[1]) || 0;
        state.heap = Number(p[2]) || 0;
        break;
      case 'VAL': state.vals[p[1]] = p[2] || ''; break;
      case 'DHT':
        state.dhtT = Number(p[1]) || 0;
        state.dhtH = Number(p[2]) || 0;
        break;
      case 'DS': state.dsT = Number(p[1]) || 0; break;
      case 'PIR': {
        const v = Number(p[1]) ? 1 : 0;
        if (v && !state.pir) state.pirHat = true;
        state.pir = v;
        break;
      }
      case 'MPU':
        state.mpu = {
          ax: Number(p[1]) || 0, ay: Number(p[2]) || 0, az: Number(p[3]) || 0,
          roll: Number(p[4]) || 0, pitch: Number(p[5]) || 0,
        };
        break;
      case 'BTN': {
        const pressed = p[2] === '1';
        if (pressed && !state.btn[p[1]]) state.btnHat[p[1]] = true;
        state.btn[p[1]] = pressed;
        break;
      }
      case 'KEY':
        state.key = p[1] || '';
        state.keyHat = true;
        break;
      case 'I2C': state.i2c = p[1] || ''; break;
      case 'PONG': state.ping = Math.max(0, Date.now() - Number(p[1])); break;
      case 'SER': state.serialText = p[1] || ''; state.serialHat = true; break;
      case 'HTTP': state.httpCode = Number(p[1]) || 0; state.httpBody = p[2] || ''; break;
      case 'ENV':
        state.env = {
          temp: Number(p[1]) || 0, pressure: Number(p[2]) || 0,
          altitude: Number(p[3]) || 0, humidity: Number(p[4]) || 0,
        };
        break;
      case 'COL':
        state.col = { red: Number(p[1]) || 0, green: Number(p[2]) || 0, blue: Number(p[3]) || 0 };
        break;
      case 'GES': {
        const d = p[1] || '';
        state.gesture = d;
        if (d) state.gestureHats[d] = true;
        state.gestureHats.any = true;
        break;
      }
      case 'PRX': state.prox = Number(p[1]) || 0; break;
      case 'HX': state.grams = Number(p[1]) || 0; break;
      case 'GPS':
        state.gps = {
          latitude: Number(p[1]) || 0, longitude: Number(p[2]) || 0, speed: Number(p[3]) || 0,
          satellites: Number(p[4]) || 0, altitude: Number(p[5]) || 0,
        };
        break;
      case 'RTC':
      case 'NTP': {
        const o = {
          year: Number(p[1]) || 0, month: Number(p[2]) || 0, day: Number(p[3]) || 0,
          hour: Number(p[4]) || 0, minute: Number(p[5]) || 0, second: Number(p[6]) || 0,
          weekday: Number(p[7]) || 0,
        };
        if (p[0] === 'RTC') state.rtc = o; else state.ntp = o;
        break;
      }
      case 'NOW': state.nowFrom = p[1] || ''; state.nowMsg = p[2] || ''; state.nowHat = true; break;
      case 'MAC': state.mac = p[1] || ''; break;
      case 'RFID':
        if (p[1] === '1') {
          if (!state.rfidTouching) state.rfidHat = true;
          state.rfidTouching = true;
          state.rfidUid = p[2] || '';
        } else {
          state.rfidTouching = false;
        }
        break;
      case 'IR':
        state.ir[p[1]] = p[2] || '';
        state.irPulse[p[1]] = Date.now();
        state.irHat[p[1]] = true;
        break;
      default: break;
    }
  }

  function watch(kind, p) {
    const key = String(p);
    if (key === '' || watched[kind].has(key)) return;
    if (!ws || ws.readyState !== 1) return;
    watched[kind].add(key);
    send(WATCH_CMD[kind], key);
  }

  const wait = (seconds) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(seconds) || 0) * 1000));

  // ---------------------------------------------------------------
  // Auto-reconnect + ping
  // ---------------------------------------------------------------
  let lastAddr = '';
  let autoReconnect = true;
  let intentionalClose = false;
  let reconnectTimer = null;
  let pingTimer = null;

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }
  function startPing() {
    stopPing();
    pingTimer = setInterval(() => send('PING', Date.now()), 2000);
  }
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (!autoReconnect || intentionalClose || !lastAddr) return;
    reconnectTimer = setTimeout(() => {
      if (!autoReconnect || intentionalClose) return;
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      openSocket(lastAddr);
    }, 3000);
  }
  function openSocket(addr) {
    return new Promise((resolve) => {
      let socket;
      try {
        socket = new WebSocket('ws://' + addr);
      } catch (e) {
        resolve(false);
        scheduleReconnect();
        return;
      }
      ws = socket;
      let opened = false;
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        done(false);
        try { socket.close(); } catch (e) { /* ignore */ }
      }, 5000);
      socket.onopen = () => {
        opened = true;
        state.connected = true;
        if (state.lost) { state.lost = false; state.restoredHat = true; }
        startPing();
        done(true);
      };
      socket.onmessage = (ev) => {
        // A message may contain several lines
        String(ev.data).split('\n').forEach((line) => { if (line) handleMessage(line); });
      };
      socket.onerror = () => done(false);
      socket.onclose = () => {
        if (ws !== socket) return; // replaced by a newer connection
        resetState();
        stopPing();
        if (opened && !intentionalClose) { state.lost = true; state.lostHat = true; }
        done(false);
        scheduleReconnect();
      };
    });
  }

  // Built-in melodies as [MIDI note, beats]
  const TUNES = {
    ode: [[64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1],
      [60, 1], [60, 1], [62, 1], [64, 1], [64, 1.5], [62, 0.5], [62, 2]],
    twinkle: [[60, 1], [60, 1], [67, 1], [67, 1], [69, 1], [69, 1], [67, 2],
      [65, 1], [65, 1], [64, 1], [64, 1], [62, 1], [62, 1], [60, 2]],
    jingle: [[64, 1], [64, 1], [64, 2], [64, 1], [64, 1], [64, 2],
      [64, 1], [67, 1], [60, 1.5], [62, 0.5], [64, 4]],
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class ESP32Blocks {
    getInfo() {
      return {
        id: 'esp32blocks',
        name: 'ESP32',
        menuIconURI: ICON_URI,
        blockIconURI: ICON_URI,
        color1: '#3B82F6',
        color2: '#2563EB',
        color3: '#1D4ED8',
        blocks: [
          // ---------- Networking ----------
          {
            opcode: 'connectToIP',
            blockType: B.COMMAND,
            text: 'Connect to [IP] IP address',
            arguments: { IP: str('0.0.0.0') },
          },
          {
            opcode: 'isConnected',
            blockType: B.REPORTER,
            text: 'Connected?',
          },
          {
            opcode: 'connectionDBm',
            blockType: B.REPORTER,
            text: 'Connection dBm',
          },
          {
            opcode: 'disconnectESP',
            blockType: B.COMMAND,
            text: 'Disconnect from ESP32',
          },
          {
            opcode: 'setAutoReconnect',
            blockType: B.COMMAND,
            text: 'Auto-reconnect [STATE]',
            arguments: { STATE: { type: T.STRING, menu: 'onOff', defaultValue: 'on' } },
          },
          {
            opcode: 'connectionLost',
            blockType: B.BOOLEAN,
            text: 'Connection lost?',
          },
          {
            opcode: 'whenConnectionLost',
            blockType: B.HAT,
            text: 'When connection lost',
          },
          {
            opcode: 'whenConnectionRestored',
            blockType: B.HAT,
            text: 'When connection restored',
          },
          {
            opcode: 'pingMs',
            blockType: B.REPORTER,
            text: 'Ping in ms',
          },
          {
            opcode: 'myMac',
            blockType: B.REPORTER,
            text: 'ESP32 MAC address',
          },

          // ---------- Pins ----------
          {
            opcode: 'setDigitalPin',
            blockType: B.COMMAND,
            text: 'Set Digital Pin [PIN] to [VALUE]',
            arguments: {
              PIN: pin(),
              VALUE: { type: T.STRING, menu: 'digitalValue', defaultValue: '1' },
            },
          },
          {
            opcode: 'readDigitalPin',
            blockType: B.REPORTER,
            text: 'Read Digital Pin [PIN]',
            arguments: { PIN: pin() },
          },
          {
            opcode: 'setAnalogPin',
            blockType: B.COMMAND,
            text: 'Set Analog pin [PIN] to [VALUE]',
            arguments: { PIN: pin(), VALUE: pin() },
          },
          {
            opcode: 'readAnalogPin',
            blockType: B.REPORTER,
            text: 'Read Analog Pin [PIN]',
            arguments: { PIN: pin() },
          },
          {
            opcode: 'setPWMPin',
            blockType: B.COMMAND,
            text: 'Set PWM pin [PIN] to [VALUE] %',
            arguments: { PIN: pin(), VALUE: num(50) },
          },
          {
            opcode: 'touchValue',
            blockType: B.REPORTER,
            text: 'Touch value at pin [PIN]',
            arguments: { PIN: pin() },
          },
          {
            opcode: 'buttonPressed',
            blockType: B.BOOLEAN,
            text: 'Button on pin [PIN] pressed?',
            arguments: { PIN: pin() },
          },
          {
            opcode: 'whenButtonPressed',
            blockType: B.HAT,
            text: 'When button on pin [PIN] pressed',
            arguments: { PIN: pin() },
          },

          {
            opcode: 'fadePin',
            blockType: B.COMMAND,
            text: 'Fade pin [PIN] from [FROM] % to [TO] % in [SECONDS] seconds',
            arguments: { PIN: pin(), FROM: num(0), TO: num(100), SECONDS: num(2) },
          },
          {
            opcode: 'blinkPin',
            blockType: B.COMMAND,
            text: 'Blink pin [PIN] every [SECONDS] seconds',
            arguments: { PIN: pin(), SECONDS: num(0.5) },
          },
          {
            opcode: 'stopBlinkPin',
            blockType: B.COMMAND,
            text: 'Stop blinking pin [PIN]',
            arguments: { PIN: pin() },
          },
          {
            opcode: 'digitalSensor',
            blockType: B.BOOLEAN,
            text: '[SENSOR] detected at pin [PIN] (active [LEVEL])?',
            arguments: {
              SENSOR: { type: T.STRING, menu: 'sensorKind', defaultValue: 'water' },
              PIN: pin(),
              LEVEL: { type: T.STRING, menu: 'activeLevel', defaultValue: 'low' },
            },
          },
          {
            opcode: 'batteryPercent',
            blockType: B.REPORTER,
            text: 'Battery % at pin [PIN] divider ratio [RATIO] full [FULL] V empty [EMPTY] V',
            arguments: { PIN: pin(), RATIO: num(2), FULL: num(4.2), EMPTY: num(3.2) },
          },
          {
            opcode: 'currentSensor',
            blockType: B.REPORTER,
            text: 'ACS712 [MODEL] current in A at pin [PIN] divider ratio [RATIO]',
            arguments: {
              MODEL: { type: T.STRING, menu: 'currentModel', defaultValue: '5' },
              PIN: pin(),
              RATIO: num(1.5),
            },
          },

          // ---------- Servo ----------
          {
            opcode: 'setServoAngle',
            blockType: B.COMMAND,
            text: 'Set Servo angle to [ANGLE] at pin [PIN]',
            arguments: { ANGLE: { type: T.ANGLE, defaultValue: 90 }, PIN: pin() },
          },
          {
            opcode: 'moveServoSlowly',
            blockType: B.COMMAND,
            text: 'Move servo at pin [PIN] to [ANGLE] slowly in [SECONDS] seconds',
            arguments: {
              PIN: pin(),
              ANGLE: { type: T.ANGLE, defaultValue: 180 },
              SECONDS: num(2),
            },
          },

          // ---------- RFID ----------
          {
            opcode: 'setupRFID',
            blockType: B.COMMAND,
            text: 'Setup RFID reader to SDA [SDA] SCK [SCK] MOSI [MOSI] MISO [MISO] RST [RST]',
            arguments: { SDA: pin(), SCK: pin(), MOSI: pin(), MISO: pin(), RST: pin() },
          },
          {
            opcode: 'isTouchingRFID',
            blockType: B.REPORTER,
            text: 'Is touching RFID card/tag',
          },
          {
            opcode: 'readRFID',
            blockType: B.REPORTER,
            text: 'Read RFID card/tag',
          },
          {
            opcode: 'whenTouchingRFID',
            blockType: B.HAT,
            text: 'When Touching RFID card/tag',
          },

          // ---------- Ultrasonic ----------
          {
            opcode: 'setupUltrasonic',
            blockType: B.COMMAND,
            text: 'Setup ultrasonic sensor Trig [TRIG] Echo [ECHO] with 1k resistors',
            arguments: { TRIG: pin(), ECHO: pin() },
          },
          {
            opcode: 'ultrasonicDistance',
            blockType: B.REPORTER,
            text: 'Ultrasonic sensor Distance in cm',
          },
          {
            opcode: 'ultrasonicChangedBool',
            blockType: B.BOOLEAN,
            text: 'When Ultrasonic sensor Distance changes by [CM] cm',
            arguments: { CM: pin() },
          },
          {
            opcode: 'whenUltrasonicChanged',
            blockType: B.HAT,
            text: 'When Ultrasonic sensor Distance changes by [CM] cm',
            arguments: { CM: pin() },
          },

          // ---------- Temperature / environment sensors ----------
          {
            opcode: 'setupDHT',
            blockType: B.COMMAND,
            text: 'Setup [TYPE] sensor at pin [PIN]',
            arguments: {
              TYPE: { type: T.STRING, menu: 'dhtType', defaultValue: '22' },
              PIN: pin(),
            },
          },
          {
            opcode: 'dhtTemperature',
            blockType: B.REPORTER,
            text: 'DHT temperature in °C',
          },
          {
            opcode: 'dhtHumidity',
            blockType: B.REPORTER,
            text: 'DHT humidity %',
          },
          {
            opcode: 'setupDS18B20',
            blockType: B.COMMAND,
            text: 'Setup DS18B20 at pin [PIN]',
            arguments: { PIN: pin() },
          },
          {
            opcode: 'ds18b20Temperature',
            blockType: B.REPORTER,
            text: 'DS18B20 temperature in °C',
          },

          // ---------- PIR ----------
          {
            opcode: 'setupPIR',
            blockType: B.COMMAND,
            text: 'Setup PIR sensor at pin [PIN]',
            arguments: { PIN: pin() },
          },
          {
            opcode: 'pirMotion',
            blockType: B.BOOLEAN,
            text: 'PIR motion detected?',
          },
          {
            opcode: 'whenPIRMotion',
            blockType: B.HAT,
            text: 'When PIR detects motion',
          },

          // ---------- Analog sensors (light / soil / sound / gas) ----------
          {
            opcode: 'sensorLevel',
            blockType: B.REPORTER,
            text: '[SENSOR] level % at pin [PIN]',
            arguments: {
              SENSOR: { type: T.STRING, menu: 'analogSensor', defaultValue: 'light' },
              PIN: pin(),
            },
          },

          // ---------- MPU6050 ----------
          {
            opcode: 'setupMPU',
            blockType: B.COMMAND,
            text: 'Setup MPU6050 at SDA [SDA] SCL [SCL]',
            arguments: { SDA: pin(), SCL: pin() },
          },
          {
            opcode: 'mpuValue',
            blockType: B.REPORTER,
            text: 'MPU6050 [WHAT]',
            arguments: { WHAT: { type: T.STRING, menu: 'mpuValue', defaultValue: 'roll' } },
          },

          // ---------- Buzzer ----------
          {
            opcode: 'setupBuzzer',
            blockType: B.COMMAND,
            text: 'setup Passive buzzer on pin [PIN]',
            arguments: { PIN: num(4) },
          },
          {
            opcode: 'playNote',
            blockType: B.COMMAND,
            text: 'play note [NOTE] for [SECONDS] seconds on buzzer',
            arguments: { NOTE: { type: T.NOTE, defaultValue: 60 }, SECONDS: num(0.5) },
          },
          {
            opcode: 'playFrequency',
            blockType: B.COMMAND,
            text: 'play frequency [HZ] Hz for [SECONDS] seconds on buzzer',
            arguments: { HZ: num(440), SECONDS: num(0.5) },
          },
          {
            opcode: 'buzzerRest',
            blockType: B.COMMAND,
            text: 'Rest [SECONDS] for buzzer',
            arguments: { SECONDS: num(0.5) },
          },
          {
            opcode: 'stopBuzzer',
            blockType: B.COMMAND,
            text: 'Stop buzzer',
          },

          {
            opcode: 'playMelody',
            blockType: B.COMMAND,
            text: 'play melody [TUNE] on buzzer',
            arguments: { TUNE: { type: T.STRING, menu: 'tune', defaultValue: 'ode' } },
          },

          // ---------- RGB LED ----------
          {
            opcode: 'setRGBLED',
            blockType: B.COMMAND,
            text: 'Set RGB LED at pin R [R] G [G] B [B] to color [COLOR]',
            arguments: { R: pin(), G: pin(), B: pin(), COLOR: color },
          },

          // ---------- LCD ----------
          {
            opcode: 'showTextLCD',
            blockType: B.COMMAND,
            text: 'Show text [TEXT] at LCD Display SDA [SDA] SCL [SCL]',
            arguments: { TEXT: txt(), SDA: pin(), SCL: pin() },
          },

          {
            opcode: 'setupLCD',
            blockType: B.COMMAND,
            text: 'Setup LCD display at SDA [SDA] SCL [SCL]',
            arguments: { SDA: pin(), SCL: pin() },
          },
          {
            opcode: 'lcdLine',
            blockType: B.COMMAND,
            text: 'LCD show [TEXT] on line [LINE]',
            arguments: {
              TEXT: txt(),
              LINE: { type: T.STRING, menu: 'lcdLineMenu', defaultValue: '1' },
            },
          },
          {
            opcode: 'lcdClear',
            blockType: B.COMMAND,
            text: 'LCD clear',
          },
          {
            opcode: 'lcdBacklight',
            blockType: B.COMMAND,
            text: 'LCD backlight [STATE]',
            arguments: { STATE: { type: T.STRING, menu: 'onOff', defaultValue: 'on' } },
          },

          // ---------- OLED ----------
          {
            opcode: 'setupOLED',
            blockType: B.COMMAND,
            text: 'Setup OLED display at SDA [SDA] SCL [SCL]',
            arguments: { SDA: pin(), SCL: pin() },
          },
          // OLED coordinates: the centre of the screen is x 0, y 0 (x right, y up).
          // Text, rectangles and circles are positioned by their CENTRE.
          {
            opcode: 'oledText',
            blockType: B.COMMAND,
            text: 'OLED show text [TEXT] centred at x [X] y [Y] size [SIZE]',
            arguments: { TEXT: txt(), X: num(0), Y: num(0), SIZE: num(1) },
          },
          {
            opcode: 'oledLine',
            blockType: B.COMMAND,
            text: 'OLED draw line from x [X1] y [Y1] to x [X2] y [Y2]',
            arguments: { X1: num(-60), Y1: num(-30), X2: num(60), Y2: num(30) },
          },
          {
            opcode: 'oledRect',
            blockType: B.COMMAND,
            text: 'OLED draw rectangle centred at x [X] y [Y] width [W] height [H] [FILL]',
            arguments: {
              X: num(0), Y: num(0), W: num(40), H: num(20),
              FILL: { type: T.STRING, menu: 'fillState', defaultValue: '0' },
            },
          },
          {
            opcode: 'oledCircle',
            blockType: B.COMMAND,
            text: 'OLED draw circle centred at x [X] y [Y] radius [R] [FILL]',
            arguments: {
              X: num(0), Y: num(0), R: num(15),
              FILL: { type: T.STRING, menu: 'fillState', defaultValue: '0' },
            },
          },
          {
            opcode: 'oledBar',
            blockType: B.COMMAND,
            text: 'OLED progress bar centred at x [X] y [Y] width [W] height [H] value [PERCENT] %',
            arguments: { X: num(0), Y: num(0), W: num(100), H: num(10), PERCENT: num(50) },
          },
          {
            opcode: 'oledClear',
            blockType: B.COMMAND,
            text: 'OLED clear',
          },

          // ---------- 8x8 LED matrix (MAX7219) ----------
          {
            opcode: 'setupMatrix',
            blockType: B.COMMAND,
            text: 'Setup 8x8 matrix DIN [DIN] CLK [CLK] CS [CS]',
            arguments: { DIN: pin(), CLK: pin(), CS: pin() },
          },
          {
            opcode: 'showPattern',
            blockType: B.COMMAND,
            text: 'Show 8x8 pattern row1 [R1] row2 [R2] row3 [R3] row4 [R4] row5 [R5] row6 [R6] row7 [R7] row8 [R8]',
            arguments: {
              R1: txt('00111100'), R2: txt('01000010'), R3: txt('10100101'), R4: txt('10000001'),
              R5: txt('10100101'), R6: txt('10011001'), R7: txt('01000010'), R8: txt('00111100'),
            },
          },
          {
            opcode: 'setMatrixLed',
            blockType: B.COMMAND,
            text: 'Set 8x8 LED x [X] y [Y] to [STATE]',
            arguments: {
              X: num(1), Y: num(1),
              STATE: { type: T.STRING, menu: 'onOff', defaultValue: 'on' },
            },
          },
          {
            opcode: 'clearMatrix',
            blockType: B.COMMAND,
            text: '8x8 clear',
          },
          {
            opcode: 'matrixBrightness',
            blockType: B.COMMAND,
            text: 'Set 8x8 brightness to [LEVEL] (0 to 15)',
            arguments: { LEVEL: num(8) },
          },

          // ---------- TM1637 ----------
          {
            opcode: 'showTM1637',
            blockType: B.COMMAND,
            text: 'Show number [NUMBER] on TM1637 display CLK [CLK] DIO [DIO]',
            arguments: { NUMBER: num(1234), CLK: pin(), DIO: pin() },
          },

          // ---------- Joystick ----------
          {
            opcode: 'setupJoystick',
            blockType: B.COMMAND,
            text: 'Setup Joystick at pin VRX [VRX] VRY [VRY] SW [SW]',
            arguments: { VRX: pin(), VRY: pin(), SW: pin() },
          },
          {
            opcode: 'joystick',
            blockType: B.REPORTER,
            text: 'Joystick [AXIS]',
            arguments: { AXIS: { type: T.STRING, menu: 'joystickAxis', defaultValue: 'Y' } },
          },
          {
            opcode: 'joystickSW',
            blockType: B.REPORTER,
            text: 'Joystick SW',
          },

          // ---------- Keypad ----------
          {
            opcode: 'setupKeypad',
            blockType: B.COMMAND,
            text: 'Setup 4x4 keypad rows [R1] [R2] [R3] [R4] columns [C1] [C2] [C3] [C4]',
            arguments: {
              R1: pin(), R2: pin(), R3: pin(), R4: pin(),
              C1: pin(), C2: pin(), C3: pin(), C4: pin(),
            },
          },
          {
            opcode: 'lastKey',
            blockType: B.REPORTER,
            text: 'Last keypad key',
          },
          {
            opcode: 'whenKeyPressed',
            blockType: B.HAT,
            text: 'When keypad key pressed',
          },

          // ---------- NeoPixel ----------
          {
            opcode: 'setupNeoPixel',
            blockType: B.COMMAND,
            text: 'setup NeoPixel strip with [COUNT] LEDs on pin [PIN]',
            arguments: { COUNT: num(8), PIN: num(15) },
          },
          {
            opcode: 'setNeoPixel',
            blockType: B.COMMAND,
            text: 'set NeoPixel at index [INDEX] to color [COLOR]',
            arguments: { INDEX: num(0), COLOR: color },
          },
          {
            opcode: 'setAllNeoPixels',
            blockType: B.COMMAND,
            text: 'set all NeoPixels to color [COLOR]',
            arguments: { COLOR: color },
          },
          {
            opcode: 'setNeoBrightness',
            blockType: B.COMMAND,
            text: 'set NeoPixel brightness to [PERCENT] %',
            arguments: { PERCENT: num(50) },
          },
          {
            opcode: 'setAllLEDsOff',
            blockType: B.COMMAND,
            text: 'Set all LEDs to off',
          },

          {
            opcode: 'neoEffect',
            blockType: B.COMMAND,
            text: 'NeoPixel effect [EFFECT] color [COLOR] speed [SPEED] (1 to 10)',
            arguments: {
              EFFECT: { type: T.STRING, menu: 'neoEffectMenu', defaultValue: 'rainbow' },
              COLOR: color,
              SPEED: num(5),
            },
          },
          {
            opcode: 'stopNeoEffect',
            blockType: B.COMMAND,
            text: 'Stop NeoPixel effect',
          },

          // ---------- Rotary encoder ----------
          {
            opcode: 'setupRotary',
            blockType: B.COMMAND,
            text: 'setup rotary encoder: CLK [CLK] DT [DT]',
            arguments: { CLK: num(14), DT: num(27) },
          },
          {
            opcode: 'rotaryPosition',
            blockType: B.REPORTER,
            text: 'rotary encoder position',
          },

          // ---------- IR ----------
          {
            opcode: 'whenIRReceived',
            blockType: B.HAT,
            text: 'When I receive IR code on pin [PIN]',
            arguments: { PIN: pin() },
          },
          {
            opcode: 'lastIRCode',
            blockType: B.REPORTER,
            text: 'last IR code on pin [PIN]',
            arguments: { PIN: pin() },
          },
          {
            opcode: 'irCodeReceived',
            blockType: B.BOOLEAN,
            text: 'IR code received on pin [PIN]',
            arguments: { PIN: pin() },
          },

          // ---------- DFPlayer ----------
          {
            opcode: 'setupDFPlayer',
            blockType: B.COMMAND,
            text: 'Setup DFplayer at pin TX [TX] RX [RX]',
            arguments: { TX: pin(), RX: pin() },
          },
          {
            opcode: 'playAudioTrack',
            blockType: B.COMMAND,
            text: 'Play Audio track [TRACK]',
            arguments: { TRACK: str('0001') },
          },
          {
            opcode: 'setVolume',
            blockType: B.COMMAND,
            text: 'Set Volume to [VOLUME] 0 to 30',
            arguments: { VOLUME: num(15) },
          },

          // ---------- BMP280 / BME280 ----------
          {
            opcode: 'setupEnv',
            blockType: B.COMMAND,
            text: 'Setup [TYPE] at SDA [SDA] SCL [SCL]',
            arguments: {
              TYPE: { type: T.STRING, menu: 'bmeType', defaultValue: 'BME280' },
              SDA: pin(), SCL: pin(),
            },
          },
          {
            opcode: 'envValue',
            blockType: B.REPORTER,
            text: 'Environment [WHAT]',
            arguments: { WHAT: { type: T.STRING, menu: 'envWhat', defaultValue: 'temp' } },
          },

          // ---------- Color sensor (TCS34725) ----------
          {
            opcode: 'setupColor',
            blockType: B.COMMAND,
            text: 'Setup color sensor TCS34725 at SDA [SDA] SCL [SCL]',
            arguments: { SDA: pin(), SCL: pin() },
          },
          {
            opcode: 'colorValue',
            blockType: B.REPORTER,
            text: 'Color sensor [CHANNEL] (0 to 255)',
            arguments: { CHANNEL: { type: T.STRING, menu: 'colorChannel', defaultValue: 'red' } },
          },
          {
            opcode: 'colorHex',
            blockType: B.REPORTER,
            text: 'Color sensor color (hex)',
          },

          // ---------- Gesture sensor (APDS9960) ----------
          {
            opcode: 'setupGesture',
            blockType: B.COMMAND,
            text: 'Setup gesture sensor APDS9960 at SDA [SDA] SCL [SCL]',
            arguments: { SDA: pin(), SCL: pin() },
          },
          {
            opcode: 'lastGesture',
            blockType: B.REPORTER,
            text: 'Last gesture',
          },
          {
            opcode: 'whenGesture',
            blockType: B.HAT,
            text: 'When gesture [DIR] detected',
            arguments: { DIR: { type: T.STRING, menu: 'gestureDir', defaultValue: 'any' } },
          },
          {
            opcode: 'gestureProximity',
            blockType: B.REPORTER,
            text: 'Gesture sensor proximity',
          },

          // ---------- Scale (HX711) ----------
          {
            opcode: 'setupScale',
            blockType: B.COMMAND,
            text: 'Setup scale HX711 DT [DT] SCK [SCK]',
            arguments: { DT: pin(), SCK: pin() },
          },
          {
            opcode: 'tareScale',
            blockType: B.COMMAND,
            text: 'Tare scale (set to zero)',
          },
          {
            opcode: 'scaleCalibration',
            blockType: B.COMMAND,
            text: 'Set scale calibration factor to [FACTOR]',
            arguments: { FACTOR: num(420) },
          },
          {
            opcode: 'weightGrams',
            blockType: B.REPORTER,
            text: 'Weight in grams',
          },

          // ---------- GPS (NEO-6M) ----------
          {
            opcode: 'setupGPS',
            blockType: B.COMMAND,
            text: 'Setup GPS RX [RX] TX [TX]',
            arguments: { RX: pin(), TX: pin() },
          },
          {
            opcode: 'gpsValue',
            blockType: B.REPORTER,
            text: 'GPS [WHAT]',
            arguments: { WHAT: { type: T.STRING, menu: 'gpsWhat', defaultValue: 'latitude' } },
          },

          // ---------- Clock (DS3231) + internet time ----------
          {
            opcode: 'setupRTC',
            blockType: B.COMMAND,
            text: 'Setup DS3231 clock at SDA [SDA] SCL [SCL]',
            arguments: { SDA: pin(), SCL: pin() },
          },
          {
            opcode: 'setRTCNow',
            blockType: B.COMMAND,
            text: "Set DS3231 clock to this computer's time",
          },
          {
            opcode: 'rtcTime',
            blockType: B.REPORTER,
            text: 'Clock [FIELD]',
            arguments: { FIELD: { type: T.STRING, menu: 'timeField', defaultValue: 'hour' } },
          },
          {
            opcode: 'syncNTP',
            blockType: B.COMMAND,
            text: 'Sync time from internet UTC offset [HOURS] hours',
            arguments: { HOURS: num(5.5) },
          },
          {
            opcode: 'ntpTime',
            blockType: B.REPORTER,
            text: 'Internet time [FIELD]',
            arguments: { FIELD: { type: T.STRING, menu: 'timeField', defaultValue: 'hour' } },
          },

          // ---------- HTTP ----------
          {
            opcode: 'httpGet',
            blockType: B.COMMAND,
            text: 'Send HTTP GET to [URL]',
            arguments: { URL: txt('http://example.com') },
          },
          {
            opcode: 'httpResponse',
            blockType: B.REPORTER,
            text: 'Last HTTP response',
          },
          {
            opcode: 'httpStatus',
            blockType: B.REPORTER,
            text: 'HTTP status code',
          },

          // ---------- ESP-NOW ----------
          {
            opcode: 'espNowSend',
            blockType: B.COMMAND,
            text: 'Send [MESSAGE] by ESP-NOW to MAC [MAC]',
            arguments: { MESSAGE: txt('hello'), MAC: txt('FF:FF:FF:FF:FF:FF') },
          },
          {
            opcode: 'lastNowMessage',
            blockType: B.REPORTER,
            text: 'Last ESP-NOW message',
          },
          {
            opcode: 'lastNowSender',
            blockType: B.REPORTER,
            text: 'Last ESP-NOW sender MAC',
          },
          {
            opcode: 'whenNowMessage',
            blockType: B.HAT,
            text: 'When ESP-NOW message received',
          },

          // ---------- Serial input ----------
          {
            opcode: 'lastSerial',
            blockType: B.REPORTER,
            text: 'Last serial text received',
          },
          {
            opcode: 'whenSerial',
            blockType: B.HAT,
            text: 'When serial text received',
          },

          // ---------- System ----------
          {
            opcode: 'esp32Temperature',
            blockType: B.REPORTER,
            text: 'ESP32 temperature',
          },
          {
            opcode: 'uptimeSeconds',
            blockType: B.REPORTER,
            text: 'Uptime in seconds',
          },
          {
            opcode: 'freeMemory',
            blockType: B.REPORTER,
            text: 'Free memory in bytes',
          },
          {
            opcode: 'saveValue',
            blockType: B.COMMAND,
            text: 'Save [VALUE] as [NAME] (kept after restart)',
            arguments: { VALUE: txt(), NAME: txt('score') },
          },
          {
            opcode: 'loadValue',
            blockType: B.REPORTER,
            text: 'Saved value [NAME]',
            arguments: { NAME: txt('score') },
          },
          {
            opcode: 'deepSleep',
            blockType: B.COMMAND,
            text: 'Deep sleep for [SECONDS] seconds',
            arguments: { SECONDS: num(10) },
          },
          {
            opcode: 'scanI2C',
            blockType: B.COMMAND,
            text: 'Scan I2C devices at SDA [SDA] SCL [SCL]',
            arguments: { SDA: pin(), SCL: pin() },
          },
          {
            opcode: 'i2cFound',
            blockType: B.REPORTER,
            text: 'I2C devices found',
          },
          {
            opcode: 'serialPrint',
            blockType: B.COMMAND,
            text: 'serial print [TEXT]',
            arguments: { TEXT: txt() },
          },
          {
            opcode: 'resetESP32',
            blockType: B.COMMAND,
            text: 'Reset ESP32',
          },
        ],
        menus: {
          joystickAxis: { acceptReporters: true, items: ['X', 'Y'] },
          onOff: {
            acceptReporters: false,
            items: [{ text: 'on', value: 'on' }, { text: 'off', value: 'off' }],
          },
          fillState: {
            acceptReporters: false,
            items: [{ text: 'outline', value: '0' }, { text: 'filled', value: '1' }],
          },
          lcdLineMenu: { acceptReporters: false, items: ['1', '2'] },
          activeLevel: {
            acceptReporters: false,
            items: [{ text: 'LOW', value: 'low' }, { text: 'HIGH', value: 'high' }],
          },
          sensorKind: {
            acceptReporters: false,
            items: [
              { text: 'Water level', value: 'water' },
              { text: 'Flame', value: 'flame' },
              { text: 'Vibration', value: 'vibration' },
              { text: 'Tilt switch', value: 'tilt' },
              { text: 'Magnet (hall)', value: 'magnet' },
              { text: 'Line', value: 'line' },
              { text: 'Obstacle', value: 'obstacle' },
            ],
          },
          currentModel: {
            acceptReporters: false,
            items: [
              { text: '5A', value: '5' },
              { text: '20A', value: '20' },
              { text: '30A', value: '30' },
            ],
          },
          tune: {
            acceptReporters: false,
            items: [
              { text: 'Ode to Joy', value: 'ode' },
              { text: 'Twinkle Twinkle', value: 'twinkle' },
              { text: 'Jingle Bells', value: 'jingle' },
            ],
          },
          neoEffectMenu: {
            acceptReporters: false,
            items: [
              { text: 'rainbow', value: 'rainbow' },
              { text: 'chase', value: 'chase' },
              { text: 'blink', value: 'blink' },
            ],
          },
          bmeType: { acceptReporters: false, items: ['BMP280', 'BME280'] },
          envWhat: {
            acceptReporters: false,
            items: [
              { text: 'temperature °C', value: 'temp' },
              { text: 'pressure hPa', value: 'pressure' },
              { text: 'altitude m', value: 'altitude' },
              { text: 'humidity % (BME280)', value: 'humidity' },
            ],
          },
          colorChannel: { acceptReporters: false, items: ['red', 'green', 'blue'] },
          gestureDir: { acceptReporters: false, items: ['any', 'up', 'down', 'left', 'right'] },
          gpsWhat: {
            acceptReporters: false,
            items: [
              { text: 'latitude', value: 'latitude' },
              { text: 'longitude', value: 'longitude' },
              { text: 'speed km/h', value: 'speed' },
              { text: 'satellites', value: 'satellites' },
              { text: 'altitude m', value: 'altitude' },
            ],
          },
          timeField: {
            acceptReporters: false,
            items: ['year', 'month', 'day', 'hour', 'minute', 'second', 'weekday'],
          },
          digitalValue: {
            acceptReporters: true,
            items: [
              { text: 'HIGH', value: '1' },
              { text: 'LOW', value: '0' },
            ],
          },
          dhtType: {
            acceptReporters: false,
            items: [
              { text: 'DHT11', value: '11' },
              { text: 'DHT22', value: '22' },
            ],
          },
          analogSensor: {
            acceptReporters: false,
            items: [
              { text: 'Light', value: 'light' },
              { text: 'Soil moisture', value: 'soil' },
              { text: 'Sound', value: 'sound' },
              { text: 'Gas', value: 'gas' },
            ],
          },
          mpuValue: {
            acceptReporters: false,
            items: [
              { text: 'Tilt X (roll)', value: 'roll' },
              { text: 'Tilt Y (pitch)', value: 'pitch' },
              { text: 'Acceleration X (g)', value: 'ax' },
              { text: 'Acceleration Y (g)', value: 'ay' },
              { text: 'Acceleration Z (g)', value: 'az' },
            ],
          },
        },
      };
    }

    // ================= Networking =================
    connectToIP(args) {
      let addr = String(args.IP).trim();
      if (!addr || addr === '0.0.0.0') return;
      if (!/:\d+$/.test(addr)) addr += ':81'; // default firmware port
      lastAddr = addr;
      intentionalClose = false;
      clearTimeout(reconnectTimer);
      if (ws) {
        const old = ws;
        ws = null;
        try { old.onclose = null; old.close(); } catch (e) { /* ignore */ }
      }
      resetState();
      stopPing();
      return openSocket(addr).then(() => {});
    }
    disconnectESP() {
      intentionalClose = true;
      clearTimeout(reconnectTimer);
      stopPing();
      if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    }
    setAutoReconnect(args) {
      autoReconnect = String(args.STATE) === 'on';
      if (!autoReconnect) clearTimeout(reconnectTimer);
    }
    connectionLost() { return state.lost; }
    whenConnectionLost() {
      if (state.lostHat) { state.lostHat = false; return true; }
      return false;
    }
    whenConnectionRestored() {
      if (state.restoredHat) { state.restoredHat = false; return true; }
      return false;
    }
    pingMs() { return state.ping; }
    myMac() { return state.mac; }
    isConnected() { return !!(ws && ws.readyState === 1); }
    connectionDBm() { return state.rssi; }

    // ================= Pins =================
    setDigitalPin(args) {
      const v = String(args.VALUE).trim().toUpperCase();
      const high = v === 'HIGH' || v === '1' || v === 'TRUE' || v === 'ON';
      send('DW', args.PIN, high ? 1 : 0);
    }
    readDigitalPin(args) {
      watch('d', args.PIN);
      return state.dr[String(args.PIN)] || 0;
    }
    setAnalogPin(args) { send('AW', args.PIN, args.VALUE); }
    readAnalogPin(args) {
      watch('a', args.PIN);
      return state.ar[String(args.PIN)] || 0;
    }
    setPWMPin(args) {
      const pct = Math.min(100, Math.max(0, Number(args.VALUE) || 0));
      send('PWM', args.PIN, pct);
    }
    touchValue(args) {
      watch('t', args.PIN);
      return state.tc[String(args.PIN)] || 0;
    }
    buttonPressed(args) {
      watch('b', args.PIN);
      return !!state.btn[String(args.PIN)];
    }
    whenButtonPressed(args) {
      const p = String(args.PIN);
      watch('b', p);
      if (state.btnHat[p]) { state.btnHat[p] = false; return true; }
      return false;
    }

    // ================= Servo =================
    setServoAngle(args) {
      const a = Math.min(180, Math.max(0, Number(args.ANGLE) || 0));
      send('SERVO', a, args.PIN);
      state.servoAngle[String(args.PIN)] = a;
    }
    async moveServoSlowly(args) {
      const p = String(args.PIN);
      const target = Math.min(180, Math.max(0, Number(args.ANGLE) || 0));
      const secs = Math.max(0, Number(args.SECONDS) || 0);
      const from = state.servoAngle[p] === undefined ? 90 : state.servoAngle[p];
      const stepMs = 25;
      const steps = Math.max(1, Math.round((secs * 1000) / stepMs));
      for (let i = 1; i <= steps; i++) {
        const angle = Math.round(from + ((target - from) * i) / steps);
        send('SERVO', angle, p);
        await new Promise((r) => setTimeout(r, stepMs));
      }
      state.servoAngle[p] = target;
    }

    // ================= RFID =================
    setupRFID(a) { send('RFIDSETUP', a.SDA, a.SCK, a.MOSI, a.MISO, a.RST); }
    isTouchingRFID() { return state.rfidTouching; }
    readRFID() { return state.rfidUid; }
    whenTouchingRFID() {
      if (state.rfidHat) { state.rfidHat = false; return true; }
      return false;
    }

    // ================= Ultrasonic =================
    setupUltrasonic(a) { send('ULTRASETUP', a.TRIG, a.ECHO); }
    ultrasonicDistance() { return state.dist; }
    // True for 1 second after the reading jumps by at least CM compared to the
    // previous reading (e.g. 100 cm -> 10 cm is a jump of 90, so "changes by 10" is true).
    distanceJumped(cmArg) {
      const cm = Math.abs(Number(cmArg) || 0);
      const now = Date.now();
      state.distEvents = state.distEvents.filter((e) => now - e.t < 1000);
      return cm > 0 && state.distEvents.some((e) => e.d >= cm);
    }
    ultrasonicChangedBool(args) { return this.distanceJumped(args.CM); }
    whenUltrasonicChanged(args) { return this.distanceJumped(args.CM); }

    // ================= Temperature sensors =================
    setupDHT(args) { send('DHTSETUP', args.PIN, args.TYPE); }
    dhtTemperature() { return state.dhtT; }
    dhtHumidity() { return state.dhtH; }
    setupDS18B20(args) { send('DSSETUP', args.PIN); }
    ds18b20Temperature() { return state.dsT; }

    // ================= PIR =================
    setupPIR(args) { send('PIRSETUP', args.PIN); }
    pirMotion() { return !!state.pir; }
    whenPIRMotion() {
      if (state.pirHat) { state.pirHat = false; return true; }
      return false;
    }

    // ================= Analog sensors =================
    sensorLevel(args) {
      watch('a', args.PIN);
      const raw = state.ar[String(args.PIN)] || 0;
      let pct = (raw / 4095) * 100;
      if (args.SENSOR === 'soil') pct = 100 - pct; // dry soil reads high, so invert
      return Math.round(Math.min(100, Math.max(0, pct)));
    }

    // ================= MPU6050 =================
    setupMPU(a) { send('MPUSETUP', a.SDA, a.SCL); }
    mpuValue(args) {
      const v = state.mpu[args.WHAT];
      return v === undefined ? 0 : Math.round(v * 100) / 100;
    }

    // ================= Buzzer =================
    setupBuzzer(args) { send('BUZSETUP', args.PIN); }
    playNote(args) {
      const midi = Number(args.NOTE) || 60;
      const secs = Math.max(0, Number(args.SECONDS) || 0);
      const hz = Math.round(440 * Math.pow(2, (midi - 69) / 12));
      send('TONE', hz, Math.round(secs * 1000));
      return wait(secs);
    }
    playFrequency(args) {
      const hz = Math.max(1, Math.round(Number(args.HZ) || 440));
      const secs = Math.max(0, Number(args.SECONDS) || 0);
      send('TONE', hz, Math.round(secs * 1000));
      return wait(secs);
    }
    buzzerRest(args) { return wait(args.SECONDS); }
    stopBuzzer() { send('NOTONE'); }

    // ================= RGB LED / LCD =================
    setRGBLED(a) { send('RGB', a.R, a.G, a.B, a.COLOR); }
    showTextLCD(a) { send('LCD', a.SDA, a.SCL, a.TEXT); }

    // ================= OLED =================
    setupOLED(a) { send('OLEDSETUP', a.SDA, a.SCL); }
    // Coordinates: centre of the screen is (0, 0); x to the right, y up.
    oledText(a) { send('OLEDTEXT', a.TEXT, a.X, a.Y, a.SIZE); }
    oledLine(a) { send('OLEDLINE', a.X1, a.Y1, a.X2, a.Y2); }
    oledRect(a) { send('OLEDRECT', a.X, a.Y, a.W, a.H, Number(a.FILL) ? 1 : 0); }
    oledCircle(a) { send('OLEDCIRCLE', a.X, a.Y, a.R, Number(a.FILL) ? 1 : 0); }
    oledBar(a) { send('OLEDBAR', a.X, a.Y, a.W, a.H, clamp(Number(a.PERCENT) || 0, 0, 100)); }
    oledClear() { send('OLEDCLEAR'); }

    // ================= LCD extras =================
    setupLCD(a) { send('LCDSETUP', a.SDA, a.SCL); }
    lcdLine(a) { send('LCDLINE', a.LINE, a.TEXT); }
    lcdClear() { send('LCDCLEAR'); }
    lcdBacklight(a) { send('LCDLIGHT', String(a.STATE) === 'on' ? 1 : 0); }

    // ================= 8x8 matrix (MAX7219) =================
    setupMatrix(a) { send('MXSETUP', a.DIN, a.CLK, a.CS); }
    showPattern(a) { send('MXPATTERN', a.R1, a.R2, a.R3, a.R4, a.R5, a.R6, a.R7, a.R8); }
    setMatrixLed(a) { send('MXLED', a.X, a.Y, String(a.STATE) === 'on' ? 1 : 0); }
    clearMatrix() { send('MXCLEAR'); }
    matrixBrightness(a) { send('MXBRIGHT', clamp(Math.round(Number(a.LEVEL) || 0), 0, 15)); }

    // ================= NeoPixel effects =================
    neoEffect(a) { send('NEOFX', a.EFFECT, a.COLOR, clamp(Number(a.SPEED) || 5, 1, 10)); }
    stopNeoEffect() { send('NEOFX', 'off', '#000000', 1); }

    // ================= Pin extras =================
    async fadePin(a) {
      const from = clamp(Number(a.FROM) || 0, 0, 100);
      const to = clamp(Number(a.TO) || 0, 0, 100);
      const secs = Math.max(0, Number(a.SECONDS) || 0);
      const stepMs = 25;
      const steps = Math.max(1, Math.round((secs * 1000) / stepMs));
      for (let i = 1; i <= steps; i++) {
        send('PWM', a.PIN, Math.round(from + ((to - from) * i) / steps));
        await sleep(stepMs);
      }
    }
    blinkPin(a) { send('BLINK', a.PIN, Math.max(20, Math.round((Number(a.SECONDS) || 0.5) * 1000))); }
    stopBlinkPin(a) { send('BLINKSTOP', a.PIN); }
    digitalSensor(a) {
      watch('d', a.PIN);
      const v = state.dr[String(a.PIN)];
      if (v === undefined) return false;
      return String(a.LEVEL) === 'low' ? v === 0 : v === 1;
    }
    batteryPercent(a) {
      watch('a', a.PIN);
      const raw = state.ar[String(a.PIN)] || 0;
      const volts = (raw / 4095) * 3.3 * (Number(a.RATIO) || 1);
      const full = Number(a.FULL) || 4.2;
      const empty = Number(a.EMPTY) || 3.2;
      return Math.round(clamp(((volts - empty) / (full - empty)) * 100, 0, 100));
    }
    currentSensor(a) {
      watch('a', a.PIN);
      const raw = state.ar[String(a.PIN)] || 0;
      const volts = (raw / 4095) * 3.3 * (Number(a.RATIO) || 1);
      const sens = { 5: 0.185, 20: 0.1, 30: 0.066 }[String(a.MODEL)] || 0.185;
      return Math.round(((volts - 2.5) / sens) * 100) / 100;
    }

    // ================= Melodies =================
    async playMelody(a) {
      const tune = TUNES[a.TUNE] || [];
      for (const [note, beats] of tune) {
        const ms = beats * 400;
        const hz = Math.round(440 * Math.pow(2, (note - 69) / 12));
        send('TONE', hz, Math.round(ms * 0.9));
        await sleep(ms);
      }
    }

    // ================= Touch / BMP280 / BME280 =================
    setupEnv(a) { send('ENVSETUP', a.TYPE, a.SDA, a.SCL); }
    envValue(a) {
      const v = state.env[a.WHAT];
      return v === undefined ? 0 : Math.round(v * 100) / 100;
    }

    // ================= Color sensor =================
    setupColor(a) { send('COLSETUP', a.SDA, a.SCL); }
    colorValue(a) { return Math.round(state.col[a.CHANNEL] || 0); }
    colorHex() {
      const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
      return '#' + h(state.col.red) + h(state.col.green) + h(state.col.blue);
    }

    // ================= Gesture sensor =================
    setupGesture(a) { send('GESSETUP', a.SDA, a.SCL); }
    lastGesture() { return state.gesture; }
    whenGesture(a) {
      const d = String(a.DIR);
      if (state.gestureHats[d]) { state.gestureHats[d] = false; return true; }
      return false;
    }
    gestureProximity() { return state.prox; }

    // ================= Scale (HX711) =================
    setupScale(a) { send('HXSETUP', a.DT, a.SCK); }
    tareScale() { send('HXTARE'); }
    scaleCalibration(a) { send('HXCAL', Number(a.FACTOR) || 1); }
    weightGrams() { return Math.round(state.grams * 10) / 10; }

    // ================= GPS =================
    setupGPS(a) { send('GPSSETUP', a.RX, a.TX); }
    gpsValue(a) {
      const v = state.gps[a.WHAT];
      return v === undefined ? 0 : v;
    }

    // ================= Clock / internet time =================
    setupRTC(a) { send('RTCSETUP', a.SDA, a.SCL); }
    setRTCNow() {
      const d = new Date();
      send('RTCSET', d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    }
    rtcTime(a) { return state.rtc[a.FIELD] || 0; }
    syncNTP(a) { send('NTPSYNC', Math.round((Number(a.HOURS) || 0) * 3600)); }
    ntpTime(a) { return state.ntp[a.FIELD] || 0; }

    // ================= HTTP =================
    httpGet(a) { send('HTTPGET', a.URL); }
    httpResponse() { return state.httpBody; }
    httpStatus() { return state.httpCode; }

    // ================= ESP-NOW =================
    espNowSend(a) { send('NOWSEND', a.MAC, a.MESSAGE); }
    lastNowMessage() { return state.nowMsg; }
    lastNowSender() { return state.nowFrom; }
    whenNowMessage() {
      if (state.nowHat) { state.nowHat = false; return true; }
      return false;
    }

    // ================= Serial input =================
    lastSerial() { return state.serialText; }
    whenSerial() {
      if (state.serialHat) { state.serialHat = false; return true; }
      return false;
    }

    // ================= TM1637 =================
    showTM1637(a) { send('TMSHOW', a.NUMBER, a.CLK, a.DIO); }

    // ================= Joystick =================
    setupJoystick(a) { send('JOYSETUP', a.VRX, a.VRY, a.SW); }
    joystick(args) { return String(args.AXIS).toUpperCase() === 'X' ? state.joyX : state.joyY; }
    joystickSW() { return state.joySW; }

    // ================= Keypad =================
    setupKeypad(a) {
      send('KEYSETUP', a.R1, a.R2, a.R3, a.R4, a.C1, a.C2, a.C3, a.C4);
    }
    lastKey() { return state.key; }
    whenKeyPressed() {
      if (state.keyHat) { state.keyHat = false; return true; }
      return false;
    }

    // ================= NeoPixel =================
    setupNeoPixel(a) { send('NEOSETUP', a.COUNT, a.PIN); }
    setNeoPixel(a) { send('NEOSET', a.INDEX, a.COLOR); }
    setAllNeoPixels(a) { send('NEOALL', a.COLOR); }
    setNeoBrightness(a) {
      send('NEOBRIGHT', Math.min(100, Math.max(0, Number(a.PERCENT) || 0)));
    }
    setAllLEDsOff() { send('LEDSOFF'); }

    // ================= Rotary encoder =================
    setupRotary(a) { send('ROTSETUP', a.CLK, a.DT); }
    rotaryPosition() { return state.rot; }

    // ================= IR =================
    whenIRReceived(args) {
      const p = String(args.PIN);
      watch('ir', p);
      if (state.irHat[p]) { state.irHat[p] = false; return true; }
      return false;
    }
    lastIRCode(args) {
      const p = String(args.PIN);
      watch('ir', p);
      return state.ir[p] || '';
    }
    irCodeReceived(args) {
      const p = String(args.PIN);
      watch('ir', p);
      return Date.now() - (state.irPulse[p] || 0) < 300;
    }

    // ================= DFPlayer =================
    setupDFPlayer(a) { send('DFSETUP', a.TX, a.RX); }
    playAudioTrack(args) { send('DFPLAY', parseInt(args.TRACK, 10) || 1); }
    setVolume(args) {
      send('DFVOL', Math.min(30, Math.max(0, Math.round(Number(args.VOLUME) || 0))));
    }

    // ================= System =================
    esp32Temperature() { return state.temp; }
    uptimeSeconds() { return state.uptime; }
    freeMemory() { return state.heap; }
    saveValue(args) {
      const name = String(args.NAME).slice(0, 15);
      state.vals[name] = String(args.VALUE);
      watched.ld.add(name);
      send('SAVE', name, args.VALUE);
    }
    loadValue(args) {
      const name = String(args.NAME).slice(0, 15);
      if (!watched.ld.has(name) && ws && ws.readyState === 1) {
        watched.ld.add(name);
        send('LOAD', name);
      }
      return state.vals[name] === undefined ? '' : state.vals[name];
    }
    deepSleep(args) { send('SLEEP', Math.max(1, Math.round(Number(args.SECONDS) || 1))); }
    scanI2C(a) { send('I2CSCAN', a.SDA, a.SCL); }
    i2cFound() { return state.i2c; }
    serialPrint(args) { send('SERIAL', args.TEXT); }
    resetESP32() { send('RESET'); }
  }

  Scratch.extensions.register(new ESP32Blocks());
})(Scratch);