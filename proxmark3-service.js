/**
 * BoxRFID – Filament Tag Manager
 *
 * Author: Tinkerbarn
 * License: CC BY-NC-SA 4.0 (SPDX-License-Identifier: CC-BY-NC-SA-4.0)
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Given any path the user configured (pm3.bat, proxmark3.exe, bare "proxmark3"),
 * returns { exe, clientDir, extraEnv } needed to spawn the client.
 */
function resolveExe(userPath) {
  if (process.platform !== 'win32') {
    return { exe: userPath, clientDir: path.dirname(userPath), extraEnv: {} };
  }

  // pm3.bat → proxmark3.exe lives in the sibling client/ folder
  if (/pm3\.bat$/i.test(userPath)) {
    const batDir  = path.dirname(userPath);
    const clientDir = path.join(batDir, 'client');
    const exe = path.join(clientDir, 'proxmark3.exe');
    if (fs.existsSync(exe)) {
      return { exe, clientDir, extraEnv: buildMingwEnv(clientDir) };
    }
  }

  // proxmark3.exe given directly
  if (/proxmark3\.exe$/i.test(userPath)) {
    const clientDir = path.dirname(userPath);
    const libsDir   = path.join(clientDir, 'libs');
    const extraEnv  = fs.existsSync(libsDir) ? buildMingwEnv(clientDir) : {};
    return { exe: userPath, clientDir, extraEnv };
  }

  // Bare name or custom path – use as-is
  return { exe: userPath, clientDir: process.cwd(), extraEnv: {} };
}

function buildMingwEnv(clientDir) {
  const libsDir  = path.join(clientDir, 'libs');
  const shellDir = path.join(libsDir, 'shell');
  return {
    HOME:                      clientDir,
    QT_PLUGIN_PATH:            libsDir + '\\',
    QT_QPA_PLATFORM_PLUGIN_PATH: libsDir + '\\',
    MSYSTEM:                   'MINGW64',
    PATH:                      [libsDir, shellDir, process.env.PATH || ''].join(';'),
  };
}

/**
 * Detect the Proxmark3 COM port.
 * Tries wmic first (no execution-policy issues), falls back to PowerShell.
 * Returns e.g. "COM3" or null.
 */
function detectComPort() {
  if (process.platform !== 'win32') return null;

  // wmic – works without PS execution policy, faster
  try {
    const out = execFileSync(
      'wmic',
      ['path', 'Win32_serialport',
       'where', "(PNPDeviceID like '%VID_9AC4%' or PNPDeviceID like '%VID_2D2D%')",
       'get', 'DeviceID', '/format:value'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    const m = out.match(/DeviceID=(\S+)/i);
    if (m && m[1]) return m[1].trim();
  } catch {}

  // PowerShell fallback (full path to avoid PATH issues in packaged app)
  const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  try {
    const ps =
      "Get-CimInstance Win32_SerialPort | " +
      "Where-Object {$_.PNPDeviceID -like '*VID_9AC4*' -or $_.PNPDeviceID -like '*VID_2D2D*'} | " +
      "Select-Object -First 1 -ExpandProperty DeviceID";
    const out = execFileSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 6000, windowsHide: true }).trim();
    if (out) return out;
  } catch {}

  return null;
}

// ─── service ──────────────────────────────────────────────────────────────────

const BLOCK = 4;
const KEYS  = ['D3F7D3F7D3F7', 'FFFFFFFFFFFF'];

class Proxmark3Service {
  constructor(pm3Path = 'pm3', comPort = null) {
    this.pm3Path    = pm3Path;
    this._exeInfo   = resolveExe(pm3Path);
    // Use explicit port if provided, otherwise auto-detect
    this._comPort   = comPort || detectComPort();
    this.isConnected = !!this._comPort;
    this.lastUID    = null;
    this._busy      = false;
    this._pollTimer = null;
    this._currentProc = null;

    if (this._comPort) this._startPolling();
  }

  // ── raw command execution ──────────────────────────────────────────────────

  /**
   * Spawn proxmark3.exe <port> -c "<command>" and collect all output.
   * The Proxmark3 exits on its own once the command finishes.
   */
  _runCmd(command, timeoutMs = 15000) {
    const { exe, clientDir, extraEnv } = this._exeInfo;

    if (!this._comPort) throw new Error('NFC_NOT_CONNECTED');

    return new Promise((resolve, reject) => {
      let output = '';

      const env = Object.keys(extraEnv).length
        ? { ...process.env, ...extraEnv }
        : process.env;

      const proc = spawn(exe, [this._comPort, '-c', command], {
        stdio:       ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd:         clientDir,
        env,
      });

      this._currentProc = proc;

      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        reject(new Error('TIMEOUT'));
      }, timeoutMs);

      const onData = d => { output += stripAnsi(d.toString()); };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('error', err => {
        clearTimeout(timer);
        if (this._currentProc === proc) this._currentProc = null;
        reject(err);
      });

      proc.on('close', () => {
        clearTimeout(timer);
        if (this._currentProc === proc) this._currentProc = null;
        resolve(output);
      });
    });
  }

  _killCurrentProc() {
    if (this._currentProc) {
      try { this._currentProc.kill(); } catch {}
      this._currentProc = null;
    }
  }

  // ── polling ───────────────────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    this._poll(); // immediate
    this._pollTimer = setInterval(() => this._poll(), 5000);
  }

  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  async _poll() {
    if (this._busy || this._currentProc) return;

    // Re-detect COM port if we lost it
    if (!this._comPort) {
      this._comPort = detectComPort();
      if (!this._comPort) {
        this.isConnected = false;
        this.lastUID     = null;
        return;
      }
    }

    try {
      const out = await this._runCmd('hf 14a reader', 8000);
      this.isConnected = true;
      this.lastUID = /UID\s*[:\[]?\s*[0-9A-Fa-f]/i.test(out)
        ? this._parseUID(out)
        : null;
    } catch {
      // Transient error – keep isConnected as-is, clear UID
      this.lastUID = null;
    }
  }

  // ── parsing ───────────────────────────────────────────────────────────────

  _parseUID(output) {
    const m = output.match(/UID\s*[:\[]?\s*([0-9A-Fa-f]{2}(?:[\s:][0-9A-Fa-f]{2})*)/i);
    if (!m) return null;
    return m[1].replace(/[\s:]+/g, '').toLowerCase();
  }

  _parseBlockData(output) {
    // Match exactly 16 space-separated hex bytes
    const m = output.match(/([0-9A-Fa-f]{2}(?:[ \t]+[0-9A-Fa-f]{2}){15})/);
    if (!m) return null;
    return Buffer.from(m[1].trim().split(/\s+/).map(b => parseInt(b, 16)));
  }

  // ── public API ────────────────────────────────────────────────────────────

  getCurrentUID() { return this.lastUID; }

  async readTag() {
    if (!this._comPort) throw new Error('NFC_NOT_CONNECTED');
    if (this._busy) throw new Error('Busy');

    this._stopPolling();
    this._killCurrentProc();
    this._busy = true;

    try {
      let lastErr = new Error('NFC_AUTH_FAILED');
      for (const key of KEYS) {
        try {
          const out = await this._runCmd(`hf mf rdbl --blk ${BLOCK} -a -k ${key}`, 15000);
          const data = this._parseBlockData(out);
          if (data) {
            return {
              material:     data[0] || 0,
              color:        data[1] || 0,
              manufacturer: data[2] || 1,
              rawData:      Array.from(data),
            };
          }
          if (/error|fail|no tag|wrong/i.test(out)) lastErr = new Error('NFC_AUTH_FAILED');
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    } finally {
      this._busy = false;
      this._startPolling();
    }
  }

  async writeTag(materialCode, colorCode, manufacturerCode = 1) {
    if (!this._comPort) throw new Error('NFC_NOT_CONNECTED');
    if (this._busy) throw new Error('Busy');

    this._stopPolling();
    this._killCurrentProc();
    this._busy = true;

    try {
      const buf = Buffer.alloc(16, 0x00);
      buf[0] = Number(materialCode) || 0;
      buf[1] = Number(colorCode)    || 0;
      buf[2] = Number(manufacturerCode) || 1;
      const hex = buf.toString('hex').toUpperCase();

      let lastErr = new Error('NFC_AUTH_FAILED');
      for (const key of KEYS) {
        try {
          const out = await this._runCmd(
            `hf mf wrbl --blk ${BLOCK} -a -k ${key} -d ${hex}`, 18000
          );
          // pm3 outputs "Write ( ok )" or "[+] Write block N - Successful" on success
          if (/\(\s*ok\s*\)|\[OK\]|successful|write ok/i.test(out)) return true;
          if (/auth.*error|error.*auth|fail|wrong key/i.test(out)) lastErr = new Error('NFC_AUTH_FAILED');
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    } finally {
      this._busy = false;
      this._startPolling();
    }
  }

  getStatus() {
    return {
      connected:   this.isConnected,
      readerName:  this.isConnected
        ? `Proxmark3 (${this._comPort || this.pm3Path})`
        : null,
      cardPresent: !!this.lastUID,
      uid:         this.lastUID,
    };
  }

  destroy() {
    this._stopPolling();
    this._killCurrentProc();
    this._busy      = false;
    this.isConnected = false;
  }
}

module.exports = Proxmark3Service;
