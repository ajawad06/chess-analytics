const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // DB
  connect: (config) => ipcRenderer.invoke("db:connect", config),
  disconnect: () => ipcRenderer.invoke("db:disconnect"),
  getConnectionState: () => ipcRenderer.invoke("db:getState"),
  query: (filters) => ipcRenderer.invoke("db:query", filters),
  stats: () => ipcRenderer.invoke("db:stats"),
  rawQuery: (sql, params, options) =>
    ipcRenderer.invoke("db:rawQuery", sql, params, options),
  popularMoves: (payload) => ipcRenderer.invoke("db:popularMoves", payload),

  // Navigation
  goExplorer: () => ipcRenderer.send("nav:explorer"),
  goAnalytics: () => ipcRenderer.send("nav:analytics"),
  goOpening: () => ipcRenderer.send("nav:opening"),
  goOlap: () => ipcRenderer.send("nav:olap"),
  goSettings: () => ipcRenderer.send("nav:settings"),
  openUrl: (u) => ipcRenderer.send("shell:openUrl", u),

  // Window
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
});
