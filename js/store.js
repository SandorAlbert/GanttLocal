// Loading and saving through the local server, with debounced auto-save.

const SAVE_DELAY = 600;

export class Store {
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.name = '';
    this.mtime = null;
    this.model = null;
    this.timer = 0;
    this.saving = false;
    this.again = false;
    this.stale = false;
    this.failed = false;
  }

  async list() {
    const res = await fetch('api/projects', { cache: 'no-store' });
    if (!res.ok) throw new Error('Cannot list projects (HTTP ' + res.status + ')');
    const data = await res.json();
    return data.projects || [];
  }

  async load(name) {
    const res = await fetch('api/project?name=' + encodeURIComponent(name), { cache: 'no-store' });
    if (!res.ok) throw new Error('Cannot read ' + name + '.json (HTTP ' + res.status + ')');
    const doc = await res.json();
    this.name = name;
    this.mtime = parseFloat(res.headers.get('X-Mtime')) || null;
    this.stale = false;
    return doc;
  }

  attach(model, name) {
    this.model = model;
    this.name = name;
  }

  touch() {
    if (!this.model) return;
    if (this.timer) clearTimeout(this.timer);
    const self = this;
    this.onStatus('unsaved');
    this.timer = setTimeout(function () {
      self.timer = 0;
      self.save(false);
    }, SAVE_DELAY);
  }

  async save(force) {
    if (!this.model || !this.name) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    if (this.saving) {
      this.again = true;
      return;
    }
    this.saving = true;
    this.onStatus('saving');
    // Compact on the wire; disk stays valid JSON either way. Indent only for
    // Export JSON so files shared outside the app stay readable.
    const body = JSON.stringify(this.model.toJSON());
    const headers = { 'Content-Type': 'application/json' };
    if (this.mtime !== null && !force && !this.stale) headers['X-If-Mtime'] = String(this.mtime);
    try {
      const res = await fetch('api/project?name=' + encodeURIComponent(this.name), {
        method: 'PUT',
        headers: headers,
        body: body
      });
      if (res.status === 409) {
        this.stale = true;
        this.onStatus('stale');
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      this.mtime = data.mtime;
      this.stale = false;
      this.failed = false;
      // An edit that arrived while the request was in flight keeps the flag set.
      if (!this.timer) this.model.dirty = false;
      this.onStatus(this.timer ? 'unsaved' : 'saved');
    } catch (err) {
      // The document stays dirty, so the next edit retries the write.
      this.failed = true;
      this.onStatus('error', String(err.message || err));
    } finally {
      this.saving = false;
      if (this.again) {
        this.again = false;
        this.save(force);
      }
    }
  }

  async rename(fromName, toName) {
    if (fromName === toName) {
      if (this.name === fromName) this.name = toName;
      return { ok: true, name: toName };
    }
    const res = await fetch(
      '/api/project/rename?name=' + encodeURIComponent(fromName) +
      '&newName=' + encodeURIComponent(toName),
      { method: 'POST' }
    );
    if (res.ok) {
      if (this.name === fromName) this.name = toName;
      return res.json().catch(function () { return { ok: true, name: toName }; });
    }
    // Older servers have no /rename route: copy then delete via existing APIs.
    if (res.status === 404 && this.model) {
      const doc = this.model.toJSON();
      doc.name = toName;
      const created = await this.create(toName, doc);
      await this.delete(fromName);
      this.name = toName;
      this.mtime = created && created.mtime != null ? created.mtime : null;
      return { ok: true, name: toName, fallback: true };
    }
    const data = await res.json().catch(function () { return {}; });
    throw new Error(data.error || ('Cannot rename (HTTP ' + res.status + ')'));
  }

  async create(name, doc) {
    const res = await fetch('api/project?name=' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc)
    });
    if (!res.ok) throw new Error('Cannot create ' + name + '.json (HTTP ' + res.status + ')');
    const data = await res.json();
    this.mtime = data.mtime;
    return data;
  }

  async delete(name) {
    const res = await fetch('api/project?name=' + encodeURIComponent(name), { method: 'DELETE' });
    if (!res.ok) throw new Error('Cannot delete ' + name + '.json (HTTP ' + res.status + ')');
    return res.json();
  }
}

/** Download the document as a file, for keeping a copy outside the data folder. */
export function exportFile(name, doc) {
  const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name + '.json';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

/** Fetch the assembled view-only page and save it the same way as Export JSON. */
export async function exportHtml(name) {
  const res = await fetch('api/export-html?name=' + encodeURIComponent(name), { cache: 'no-store' });
  if (!res.ok) throw new Error('Cannot export HTML (HTTP ' + res.status + ')');
  const blob = new Blob([await res.arrayBuffer()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name + '.html';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

export function importFile() {
  return new Promise(function (resolve, reject) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = function () {
      const file = input.files && input.files[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = function () {
        try {
          resolve({ name: file.name.replace(/\.json$/i, ''), doc: JSON.parse(String(reader.result)) });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(file);
    };
    input.click();
  });
}
