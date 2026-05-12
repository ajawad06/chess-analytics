(function () {
  const STORAGE_KEY = "chess_analytics_preferences_v1";

  const DEFAULTS = {
    theme: "classic",
    board: "wood",
    compact: false,
    motion: true,
    rememberExplorer: true,
  };

  const THEMES = {
    classic: {
      "--bg": "#100f14",
      "--bg2": "#19171f",
      "--bg3": "#211d28",
      "--bg4": "#2b2633",
      "--bg5": "#393140",
      "--border": "#332d3d",
      "--border2": "#514656",
      "--gold": "#d6a95f",
      "--gold2": "#f2d38b",
      "--gold-dim": "#8b6a34",
      "--gold-bg": "rgba(214, 169, 95, 0.1)",
      "--text": "#f4efe7",
      "--text2": "#bfb4aa",
      "--text3": "#766d70",
      "--green": "#74c69d",
      "--red": "#e56b6f",
      "--blue": "#8ab4d8",
      "--purple": "#c7a0cf",
    },
    midnight: {
      "--bg": "#0d1110",
      "--bg2": "#151a18",
      "--bg3": "#1c2421",
      "--bg4": "#26302c",
      "--bg5": "#303d37",
      "--border": "#2a3732",
      "--border2": "#43544d",
      "--gold": "#b7c06f",
      "--gold2": "#e3e6a8",
      "--gold-dim": "#747d3e",
      "--gold-bg": "rgba(183, 192, 111, 0.1)",
      "--text": "#edf1e8",
      "--text2": "#aeb8aa",
      "--text3": "#667069",
      "--green": "#7ccf9b",
      "--red": "#e0716f",
      "--blue": "#83a9a2",
      "--purple": "#b49ac5",
    },
    lichess: {
      "--bg": "#111111",
      "--bg2": "#191919",
      "--bg3": "#222222",
      "--bg4": "#2c2c2c",
      "--bg5": "#363636",
      "--border": "#303030",
      "--border2": "#4a4a4a",
      "--gold": "#c9a86a",
      "--gold2": "#dfc58c",
      "--gold-dim": "#80683e",
      "--gold-bg": "rgba(201, 168, 106, 0.1)",
      "--text": "#eeeeee",
      "--text2": "#b9b9b9",
      "--text3": "#777777",
      "--green": "#83b35d",
      "--red": "#d96759",
      "--blue": "#6ca0c8",
      "--purple": "#b096c8",
    },
  };

  const BOARDS = {
    wood: { "--white-sq": "#f0d9b5", "--black-sq": "#b58863" },
    slate: { "--white-sq": "#d9e1e8", "--black-sq": "#64748b" },
    green: { "--white-sq": "#e8ecd3", "--black-sq": "#779954" },
  };

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return normalize({ ...DEFAULTS, ...saved });
    } catch {
      return { ...DEFAULTS };
    }
  }

  function normalize(prefs) {
    const next = { ...DEFAULTS, ...prefs };
    if (next.theme === "ivory" || !THEMES[next.theme]) next.theme = "lichess";
    if (!BOARDS[next.board]) next.board = DEFAULTS.board;
    return next;
  }

  function write(next) {
    const prefs = normalize({ ...DEFAULTS, ...next });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    apply(prefs);
    window.dispatchEvent(new CustomEvent("app-settings-changed", { detail: prefs }));
    return prefs;
  }

  function apply(prefs = read()) {
    prefs = normalize(prefs);
    const root = document.documentElement;
    const vars = { ...THEMES[prefs.theme], ...BOARDS[prefs.board] };

    Object.entries(vars).forEach(([key, value]) => {
      root.style.setProperty(key, value);
    });

    root.dataset.theme = prefs.theme;
    root.classList.toggle("pref-compact", !!prefs.compact);
    root.classList.toggle("pref-no-motion", !prefs.motion);
  }

  window.AppSettings = {
    defaults: DEFAULTS,
    read,
    write,
    apply,
    reset: () => write({ ...DEFAULTS }),
  };

  apply();
})();
