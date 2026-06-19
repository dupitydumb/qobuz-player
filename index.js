// Qobuz Search Plugin V4
// Multi-provider search/stream with jumo-dl, YAMS, Paxsenix fallback chain

(function () {
  "use strict";

  const SOURCE_TYPE = "qobuz";

  const DEBUG = false; // Set to true to enable verbose API response logging

  const JUMO_BASE    = "https://jumo-dl.pages.dev";
  const JUMO_HEADERS = {
    "Accept":     "application/json",
    "Referer":    "https://jumo-dl.pages.dev/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
  };

  const YAMS_SEARCH_BASE = "https://api.yams.tf/search";

  const PAX_BASE = "https://api.paxsenix.org/dl/qobuz";

  // API key helpers — stored in localStorage
  function getPaxKey() {
    const raw = localStorage.getItem("qobuz_pax_api_key") || "";
    return raw.trim();
  }
  function getPaxAuth() {
    const key = getPaxKey();
    if (!key) return null;
    // Accept keys with or without the "Bearer " prefix
    return key.startsWith("Bearer ") ? key : `Bearer ${key}`;
  }

  // dabmusic kept for artist discography — no alternative exists
  const DAB_BASE = "https://dabmusic.xyz/api";

  const DEFAULT_QUALITY = "Studio Quality";

  // SVG Icons definition
  const ICONS = {
    search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
    play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
    heart: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`,
    heartOutline: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`,
    download: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`
  };

  const QobuzSearch = {
    name: "Qobuz Search",
    api: null,
    isOpen: false,
    searchTimeout: null,
    libraryTracks: new Set(),

    searchCache: {},
    _currentQuery: "",
    _scrollCache: {},
    hasNewChanges: false,

    state: {
      view: "search",
      searchType: "track",
      currentData: null,
      history: [],
      currentTitle: ""
    },

    isPlaying: null,

    init(api) {
      this.api = api;
      this.fetchLibraryTracks();
      this.injectStyles();
      this.createSearchPanel();
      this.createPlayerBarButton();

      setTimeout(() => this.createPlayerBarButton(), 500);

      if (api.stream && api.stream.registerResolver) {
        api.stream.registerResolver(SOURCE_TYPE, async (externalId, options) => {
          try {
            const streamData = await this.fetchStream(externalId);
            return streamData.url;
          } catch (err) {
            console.error("[QobuzSearch] Stream resolve error:", err);
            return null;
          }
        });
      }

      // register as a search source
      // must call onResult exactly once
      if (api.search && api.search.registerSource) {
        api.search.registerSource(SOURCE_TYPE, (query, onResult) => {
          this.handleSearchQuery(query, onResult);
        });
      }

      // register as a cover source for the covers fan-out API
      // handler must call onResult exactly once
      if (api.covers && api.covers.registerSource) {
        api.covers.registerSource(SOURCE_TYPE, (query, onResult) => {
          this.searchCoverForRPC(query.title, query.artist || "", null)
            .then(url => {
              if (url) {
                onResult({ sourceId: SOURCE_TYPE, status: "success", url, priority: 10 });
              } else {
                onResult({ sourceId: SOURCE_TYPE, status: "not_found" });
              }
            })
            .catch(err => {
              console.error("[QobuzSearch] Cover source error:", err);
              onResult({ sourceId: SOURCE_TYPE, status: "error", error: err });
            });
        });
      }
    },

    async fetchLibraryTracks() {
      if (this.api?.library?.getTracks) {
        try {
          const tracks = (await this.api.library.getTracks()) || [];
          if (!Array.isArray(tracks)) {
            this.libraryTracks = new Set();
            return;
          }
          this.libraryTracks = new Set(
            tracks
              .filter((t) => t && t.source_type === SOURCE_TYPE)
              .map((t) => t.external_id)
          );
        } catch (err) {
          console.error("[QobuzSearch] Failed to fetch library tracks:", err);
        }
      }
    },

    saveAllLabel(count) {
      if (count === 1) return "Save Track";
      if (count === 2) return "Save Both Tracks";
      return `Save All ${count} Tracks`;
    },

    formatDuration(sec) {
      if (!sec) return "--:--";
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}:${s.toString().padStart(2, '0')}`;
    },

    escapeHtml(str) {
      if (!str) return "";
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    },

    // STYLES

    injectStyles() {
      if (document.getElementById("qobuz-search-styles-v4")) return;
      const style = document.createElement("style");
      style.id = "qobuz-search-styles-v4";
      style.textContent = `
        /* Core Panels */
        #qobuz-search-panel { 
          position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.95); 
          background: var(--bg-elevated, #181818); 
          border: 1px solid var(--border-color, #333); 
          border-radius: 12px; padding: 0; width: 700px; height: 95vh; max-height: 95vh; z-index: 10001; 
          box-shadow: 0 20px 50px rgba(0,0,0,0.5); 
          opacity: 0; visibility: hidden; 
          transition: all 0.2s cubic-bezier(0, 0, 0.2, 1); 
          display: flex; flex-direction: column; overflow: hidden; position: fixed;
        }
        #qobuz-search-panel.open { opacity: 1; visibility: visible; transform: translate(-50%, -50%) scale(1); }
        #qobuz-search-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(4px); z-index: 10000; opacity: 0; visibility: hidden; transition: opacity 0.2s; }
        #qobuz-search-overlay.open { opacity: 1; visibility: visible; }

        /* Header */
        .qobuz-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color, #333); display: flex; align-items: center; gap: 16px; background: var(--bg-elevated, #181818); flex-shrink: 0; }
        .qobuz-back-btn { background: none; border: none; color: var(--text-secondary, #aaa); cursor: pointer; padding: 8px; border-radius: 50%; transition: 0.2s; display: flex; align-items: center; justify-content: center; }
        .qobuz-back-btn:hover { background: var(--bg-highlight, #333); color: var(--text-primary, #fff); }
        .qobuz-title { font-size: 18px; font-weight: 700; color: var(--text-primary, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .qobuz-close-btn { margin-left: auto; background: none; border: none; color: var(--text-secondary, #aaa); cursor: pointer; font-size: 20px; transition: 0.2s; }
        .qobuz-close-btn:hover { color: var(--text-primary, #fff); }

        /* Controls */
        .qobuz-controls { padding: 16px 24px; border-bottom: 1px solid var(--border-color, #333); background: var(--bg-elevated, #181818); }
        .qobuz-search-row { display: flex; flex-direction: column; gap: 12px; }
        .qobuz-input-wrapper { position: relative; }
        .qobuz-input { width: 100%; padding: 10px 16px 10px 40px; border-radius: 8px; border: 1px solid var(--border-color, #404040); background: #1a1a1a !important; color: #fff !important; font-size: 14px; outline: none; transition: border-color 0.2s; box-sizing: border-box; -webkit-text-fill-color: #fff !important; color-scheme: dark; }
        .qobuz-input::placeholder { color: #555 !important; -webkit-text-fill-color: #555 !important; }
        .qobuz-input:focus { border-color: var(--accent-primary, #1a62b9); background: #1a1a1a !important; }
        .qobuz-input-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-subdued, #666); display: flex; align-items: center; }

        .qobuz-tabs { display: flex; background: var(--bg-surface, #202020); padding: 3px; border-radius: 999px; gap: 2px; }
        .qobuz-tab { flex: 1; border: none; background: transparent; color: var(--text-secondary, #888); padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; border-radius: 999px; transition: 0.2s; }
        .qobuz-tab:hover { color: var(--text-primary, #fff); background: rgba(255,255,255,0.05); }
        .qobuz-tab.active { background: var(--bg-highlight, #2a2a2a); color: var(--text-primary, #fff); box-shadow: 0 2px 8px rgba(0,0,0,0.2); }

        .qobuz-quality-row { display: flex; align-items: center; gap: 8px; }
        .qobuz-quality-label { font-size: 11px; color: var(--text-subdued, #666); white-space: nowrap; }
        .qobuz-quality-select { background: var(--bg-surface, #202020); border: 1px solid var(--border-color, #404040); border-radius: 6px; color: var(--text-primary, #fff); padding: 6px 10px; font-size: 12px; cursor: pointer; flex: 1; }

        /* Content */
        .qobuz-content { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 0 0 24px; position: relative; background: var(--bg-base, #121212); width: 100%; box-sizing: border-box; }
        .qobuz-content::-webkit-scrollbar { width: 8px; }
        .qobuz-content::-webkit-scrollbar-thumb { background: var(--bg-highlight, #333); border-radius: 4px; }

        /* Hero Section */
        .qobuz-hero { padding: 24px; display: flex; gap: 24px; background: linear-gradient(to bottom, rgba(26, 98, 185, 0.1), transparent); }
        .qobuz-hero-cover { width: 160px; height: 160px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); object-fit: cover; background: var(--bg-surface, #202020); flex-shrink: 0;}
        .qobuz-hero-info { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: 4px; }
        .qobuz-hero-type { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; color: var(--text-secondary, #aaa); margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
        .qobuz-hero-title { font-size: 28px; font-weight: 800; color: var(--text-primary, #fff); line-height: 1.2; margin-bottom: 12px; }
        .qobuz-hero-meta { font-size: 13px; color: var(--text-secondary, #ccc); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .qobuz-badge { background: var(--accent-primary, #1a62b9); color: white; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 800; display: inline-block; vertical-align: middle; line-height: 1.4; }
        .qobuz-explicit-badge { background: var(--text-subdued, #555); color: var(--bg-base, #121212); padding: 1px 4px; border-radius: 2px; font-size: 9px; font-weight: 700; display: inline-block; vertical-align: middle; line-height: 1.4; flex-shrink: 0; }

        .qobuz-missing-warning { margin: 0 16px 16px; padding: 10px 14px; background: rgba(255,180,0,0.1); border: 1px solid rgba(255,180,0,0.3); border-radius: 6px; color: #ffb400; font-size: 12px; }

        /* Save All Button */
        .qobuz-save-all-btn {
            background: transparent; border: 1px solid var(--border-color, #444); color: var(--text-primary, #fff);
            padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; cursor: pointer;
            display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; transition: 0.2s;
        }
        .qobuz-save-all-btn:hover { border-color: var(--accent-primary, #1a62b9); color: var(--accent-primary, #1a62b9); }

        /* Track List */
        .qobuz-track-list { padding: 8px 16px 24px; }
        .qobuz-track-item { display: grid; grid-template-columns: 48px 1fr auto auto; align-items: center; gap: 12px; padding: 8px; border-radius: 6px; cursor: pointer; transition: 0.2s; border-bottom: 1px solid rgba(255,255,255,0.03); }
        .qobuz-track-item:hover { background: var(--bg-surface, #202020); }
        .qobuz-track-item.playing { background: rgba(26,98,185,0.08); }
        .qobuz-track-item.playing .qobuz-track-title { color: var(--accent-primary, #1a62b9); }
        
        .qobuz-track-cover-wrapper { position: relative; width: 48px; height: 48px; border-radius: 4px; overflow: hidden; background: #2a2a2a; flex-shrink: 0; }
        .qobuz-track-cover { width: 100%; height: 100%; object-fit: cover; }
        .qobuz-play-overlay {
            position: absolute; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;
            opacity: 0; transition: 0.2s; color: white;
        }
        .qobuz-track-item:hover .qobuz-play-overlay { opacity: 1; }
        .qobuz-track-item.playing .qobuz-play-overlay { opacity: 1; background: rgba(0,0,0,0.5); color: white; }

        .qobuz-track-title { font-size: 14px; color: var(--text-primary, #fff); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; line-height: 1.2; }
        .qobuz-track-artist { font-size: 12px; color: var(--text-secondary, #888); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; display: flex; align-items: center; }
        .qobuz-track-time { color: var(--text-subdued, #666); font-size: 12px; font-variant-numeric: tabular-nums; }
        
        /* Clickable Artist */
        .qobuz-clickable-artist { cursor: pointer; transition: color 0.2s; }
        .qobuz-clickable-artist:hover { color: var(--accent-primary, #1a62b9); text-decoration: underline; }

        .qobuz-track-actions { display: flex; align-items: center; gap: 8px; opacity: 0; transition: 0.2s; }
        .qobuz-track-item:hover .qobuz-track-actions { opacity: 1; }
        .qobuz-save-btn-mini { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; transition: 0.2s; }
        .qobuz-save-btn-mini:hover { color: var(--text-primary); transform: scale(1.1); }
        .qobuz-save-btn-mini.saved { color: var(--accent-primary); opacity: 1 !important; }
        .qobuz-track-item .qobuz-save-btn-mini.saved { opacity: 1; }

        /* Grid Items */
        .qobuz-grid-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 20px; padding: 20px; width: 100%; box-sizing: border-box; }
        .qobuz-card { background: var(--bg-elevated, #181818); padding: 12px; border-radius: 8px; cursor: pointer; transition: all 0.2s; border: 1px solid transparent; }
        .qobuz-card:hover { background: var(--bg-surface, #202020); transform: translateY(-4px); border-color: var(--bg-highlight, #333); }
        .qobuz-card-img { width: 100%; aspect-ratio: 1; border-radius: 6px; object-fit: cover; background: var(--bg-surface, #202020); margin-bottom: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        .qobuz-card-title { font-size: 14px; font-weight: 600; color: var(--text-primary, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; line-height: 1.2; }
        .qobuz-card-sub { font-size: 12px; color: var(--text-secondary, #888); display: flex; align-items: center; gap: 4px; overflow: hidden; line-height: 1.2; }
        .qobuz-card-sub-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
        .qobuz-card-sub-count { white-space: nowrap; flex-shrink: 0; color: var(--text-subdued, #666); }

        .qobuz-unavailable { text-align: center; padding: 40px 24px; color: var(--text-subdued, #666); font-size: 13px; }
        .qobuz-unavailable-icon { font-size: 32px; margin-bottom: 12px; }

        /* Skeleton Loading */
        .qobux-skeleton { background: #222; border-radius: 4px; animation: qobux-pulse 1.5s infinite ease-in-out; display: block; }
        @keyframes qobux-pulse { 0% { opacity: 0.4; } 50% { opacity: 0.7; } 100% { opacity: 0.4; } }

        /* Player Bar Button */
        .qobuz-playerbar-btn { display: inline-flex; align-items: center; gap: 8px; padding: 6px 16px; border-radius: 20px; border: 1px solid var(--border-color, #404040); background: transparent; color: #fff; cursor: pointer; font-size: 13px; font-weight: 700; transition: 0.2s; }
        .qobuz-playerbar-btn:hover { background: var(--bg-highlight, #2a2a2a); border-color: var(--accent-primary, #1a62b9); transform: scale(1.05); }
        .qobuz-playerbar-btn svg { fill: var(--accent-primary, #1a62b9); width: 16px; height: 16px; }

        .hidden { display: none !important; }

        .qobuz-description { font-size:13px; color:var(--text-secondary,#ccc); line-height:1.6; }
        .qobuz-description.collapsed { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
        .qobuz-show-more-btn { background:none; border:none; color:var(--accent-primary,#1a62b9); font-size:12px; cursor:pointer; padding:4px 0 0; display:block; }
        .qobuz-show-more-btn:hover { text-decoration:underline; }
        .text-center { text-align: center; color: var(--text-subdued, #666); margin-top: 60px; font-size: 14px; }

        /* Settings */
        .qobuz-settings-btn { background: none; border: none; color: var(--text-secondary, #aaa); cursor: pointer; padding: 8px; border-radius: 50%; transition: 0.2s; display: flex; align-items: center; justify-content: center; margin-left: 6px; }
        .qobuz-settings-btn:hover { background: var(--bg-highlight, #333); color: var(--text-primary, #fff); }

        #qobuz-settings-panel {
          position: absolute; top: 0; left: 0; right: 0; bottom: 0;
          background: var(--bg-elevated, #181818);
          border-radius: 12px;
          z-index: 20; display: flex; flex-direction: column;
          opacity: 0; visibility: hidden; transform: translateY(8px);
          transition: all 0.2s cubic-bezier(0, 0, 0.2, 1);
        }
        #qobuz-settings-panel.open { opacity: 1; visibility: visible; transform: translateY(0); }

        .qobuz-settings-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color, #333); display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
        .qobuz-settings-close { margin-left: auto; background: none; border: none; color: var(--text-secondary, #aaa); cursor: pointer; font-size: 20px; transition: 0.2s; }
        .qobuz-settings-close:hover { color: var(--text-primary, #fff); }
        .qobuz-settings-body { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; }
        .qobuz-settings-body::-webkit-scrollbar { width: 8px; }
        .qobuz-settings-body::-webkit-scrollbar-thumb { background: var(--bg-highlight, #333); border-radius: 4px; }
        .qobuz-api-key-input { width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border-color, #404040); background: var(--bg-surface, #202020); color: var(--text-primary, #fff); font-size: 13px; font-family: monospace; outline: none; transition: border-color 0.2s; box-sizing: border-box; }
        .qobuz-api-key-input:focus { border-color: var(--accent-primary, #1a62b9); }
        .qobuz-api-key-save { padding: 10px 20px; background: var(--accent-primary, #1a62b9); border: none; border-radius: 8px; color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; transition: 0.2s; }
        .qobuz-api-key-save:hover { filter: brightness(1.15); }
        .qobuz-api-key-status { font-size: 12px; }
        .qobuz-api-key-status.ok { color: #4caf50; }
        .qobuz-api-key-status.missing { color: #f55; }
        .qobuz-apikey-toggle-btn { display:flex; align-items:center; justify-content:space-between; width:100%; background:var(--bg-surface,#202020); border:none; border-radius:8px; color:var(--text-secondary,#aaa); font-size:13px; font-weight:600; cursor:pointer; padding:12px 16px; text-transform:uppercase; letter-spacing:0.5px; transition:background 0.2s; }
        .qobuz-apikey-toggle-btn:hover { background:var(--bg-highlight,#2a2a2a); }
        .qobuz-clickable-album { color:var(--text-secondary,#888); font-size:12px; cursor:pointer; transition:color 0.2s; }
        .qobuz-clickable-album:hover { color:var(--accent-primary,#1a62b9); }

        /* Bulk save progress bar */
        #qobuz-save-progress {
          position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
          background: var(--bg-elevated, #282828); color: var(--text-primary, #fff);
          padding: 16px 32px; border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
          z-index: 10002; display: flex; flex-direction: column; align-items: center;
          min-width: 320px; max-width: 400px; text-align: center;
        }
        #qobuz-save-progress.hidden { display: none; }
        .qobuz-progress-bar {
          width: 100%; height: 8px; background: var(--bg-highlight, #3e3e3e);
          border-radius: 4px; margin-bottom: 12px; overflow: hidden; position: relative;
        }
        .qobuz-progress-bar-inner {
          height: 100%; background: var(--accent-primary, #1a62b9);
          border-radius: 4px; width: 0%; transition: width 0.2s;
          position: absolute; left: 0; top: 0;
        }
        .qobuz-progress-text { font-size: 14px; color: var(--text-primary, #fff); }

        .qobuz-artist-avatar {
          width: 160px; height: 160px; border-radius: 50%; flex-shrink: 0;
          background: linear-gradient(135deg, var(--accent-primary, #1a62b9), #0d3d73);
          display: flex; align-items: center; justify-content: center;
          font-size: 52px; font-weight: 800; color: rgba(255,255,255,0.9);
          box-shadow: 0 8px 24px rgba(0,0,0,0.4); letter-spacing: -2px;
          user-select: none;
        }

        .qobuz-artist-card-avatar {
          width: 100%; aspect-ratio: 1; border-radius: 50%; margin-bottom: 12px;
          background: linear-gradient(135deg, var(--accent-primary, #1a62b9), #0d3d73);
          display: flex; align-items: center; justify-content: center;
          font-size: 36px; font-weight: 800; color: rgba(255,255,255,0.9);
          box-shadow: 0 4px 12px rgba(0,0,0,0.2); letter-spacing: -1px;
          user-select: none;
        }

        .qobuz-section-header {
          padding: 16px 24px 8px;
          font-size: 16px; font-weight: 700;
          color: var(--text-primary, #fff);
          
          margin-top: 8px;
        }

        @media (max-width: 768px) {
          #qobuz-search-panel {
            position: fixed;
            top: 0; left: 0;
            width: 100vw; height: 100dvh; max-height: 100dvh;
            transform: none !important;
            border-radius: 0; border: none;
            padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
            box-sizing: border-box;
            overflow-x: hidden;
          }
          #qobuz-search-panel.open { transform: none !important; }

          #qobuz-settings-panel { border-radius: 0; }
          .qobuz-settings-header { padding: calc(8px + env(safe-area-inset-top)) 16px 8px 16px; }
          .qobuz-settings-body { padding: 16px; }

          .qobuz-header {
            padding: calc(8px + env(safe-area-inset-top)) 16px 8px 16px;
            gap: 12px;
          }
          .qobuz-back-btn, .qobuz-close-btn, .qobuz-settings-btn {
            min-width: 44px; min-height: 44px;
            -webkit-tap-highlight-color: transparent;
          }
          .qobuz-title { font-size: 16px; }

          /* Sticky search controls so the bar doesn't scroll away */
          .qobuz-controls {
            position: sticky; top: 0;
            background: var(--bg-elevated, #181818);
            z-index: 10;
            padding: 12px 16px;
            border-bottom: 1px solid var(--border-color, #2a2a2a);
          }
          .qobuz-input { font-size: 16px; padding: 12px 16px 12px 40px; } /* 16px prevents iOS zoom */
          .qobuz-tabs { width: 100%; }
          .qobuz-tab { padding: 6px 12px; min-height: unset; -webkit-tap-highlight-color: transparent; }

          .qobuz-content {
            max-height: none; flex: 1;
            width: 100%; max-width: 100%; box-sizing: border-box;
            overflow-x: hidden;
            padding-bottom: calc(16px + env(safe-area-inset-bottom));
          }

          .qobuz-hero { flex-direction: column; align-items: center; text-align: center; padding: 16px; gap: 16px; }
          .qobuz-hero-cover { width: 140px; height: 140px; }
          .qobuz-hero-title { font-size: 20px; }
          .qobuz-hero-meta { justify-content: center; }

          .qobuz-save-all-btn { padding: 10px 16px; min-height: 44px; -webkit-tap-highlight-color: transparent; }

          .qobuz-track-item { grid-template-columns: 44px 1fr auto auto; padding: 6px 8px; -webkit-tap-highlight-color: transparent; align-items: center; }
          .qobuz-track-actions { opacity: 1; }
          .qobuz-save-btn-mini { position: relative; min-width: unset; min-height: unset; padding: 10px 4px 10px 16px; -webkit-tap-highlight-color: transparent; }
          .qobuz-save-btn-mini::after { content: ''; position: absolute; inset: -10px -4px; }
          .qobuz-play-overlay { display: none; }
          .qobuz-clickable-artist { min-height: unset; display: inline; -webkit-tap-highlight-color: transparent; }

          .qobuz-track-list { padding: 4px 12px 8px; }
          .qobuz-section-header { padding: 8px 16px 4px; margin-top: 0; }
          .qobuz-grid-list { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 8px 12px 12px; max-width: 100%; box-sizing: border-box; }
          .qobuz-card { -webkit-tap-highlight-color: transparent; min-width: 0; max-width: 100%; box-sizing: border-box; overflow: hidden; padding: 8px; }
          .qobuz-card-img { width: 100%; max-width: 100%; margin-bottom: 6px; }
          .qobuz-card-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .qobuz-card-sub { overflow: hidden; }

          .qobuz-artist-avatar { width: 120px; height: 120px; font-size: 40px; }
          .qobuz-artist-card-avatar { font-size: 28px; }

          /* Progress bar and toast */
          #qobuz-save-progress {
            bottom: calc(20px + env(safe-area-inset-bottom));
            max-width: 90vw; min-width: auto; padding: 12px 20px;
          }
        }
        
        @media (max-width: 480px) {
          .qobuz-badge { display: none; }
        }
      `;
      document.head.appendChild(style);
    },

    // UI SETUP
    
    createSearchPanel() {
      const overlay = document.createElement("div");
      overlay.id = "qobuz-search-overlay";
      overlay.onclick = () => this.close();
      document.body.appendChild(overlay);

      // Progress bar for bulk saves
      const progressEl = document.createElement("div");
      progressEl.id = "qobuz-save-progress";
      progressEl.className = "hidden";
      progressEl.innerHTML = `
        <div class="qobuz-progress-bar"><div class="qobuz-progress-bar-inner"></div></div>
        <div class="qobuz-progress-text"></div>
      `;
      document.body.appendChild(progressEl);

      const panel = document.createElement("div");
      panel.id = "qobuz-search-panel";
      panel.innerHTML = `
        <div class="qobuz-header">
          <button id="qobuz-back-btn" class="qobuz-back-btn hidden" title="Back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
          <div class="qobuz-title" id="qobuz-panel-title">Qobuz Search</div>
          <button id="qobuz-settings-btn" class="qobuz-settings-btn" title="Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
          <button class="qobuz-close-btn" title="Close">✕</button>
        </div>

        <div id="qobuz-settings-panel">
          <div class="qobuz-settings-header">
            <div class="qobuz-title">Settings</div>
            <button class="qobuz-settings-close" title="Close settings">✕</button>
          </div>
          <div class="qobuz-settings-body">

            <p style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; color:var(--text-secondary,#aaa); margin:0 0 8px;">Paxsenix API Key</p>
            <div style="display:flex; gap:8px; margin-bottom:8px;">
              <input type="text" id="qobuz-pax-key-input" class="qobuz-api-key-input" placeholder="sk-paxsenix-…" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" inputmode="text" style="flex:1; min-width:0;">
              <button id="qobuz-pax-key-save" class="qobuz-api-key-save">Save</button>
            </div>
            <p id="qobuz-pax-key-status" class="qobuz-api-key-status" style="margin:0 0 16px;"></p>

            <p style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; color:var(--text-secondary,#aaa); margin:0 0 8px;">Streaming Quality</p>
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:20px;">
              <span style="font-size:11px; color:var(--text-subdued,#666); white-space:nowrap;">Quality</span>
              <select id="qobuz-quality-select" class="qobuz-quality-select" style="flex:1;">
                <option value="320kbps">320 kbps</option>
                <option value="CD">CD Lossless</option>
                <option value="Hi-Res">Hi-Res</option>
                <option value="Studio Quality" selected>Studio Quality</option>
              </select>
            </div>

            <button id="qobuz-apikey-toggle" class="qobuz-apikey-toggle-btn">
              <span>How to get your API key</span>
              <svg id="qobuz-apikey-arrow" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="transition:transform 0.2s; flex-shrink:0;"><path d="M7 10l5 5 5-5z"/></svg>
            </button>
            <div id="qobuz-apikey-steps" style="display:none; padding:8px 0 4px;">
              <p style="font-size:12px; color:var(--text-secondary,#ccc); line-height:1.5; margin:0 0 6px;"><span style="font-weight:700;">1.</span> Visit <a href="https://api.paxsenix.org/dashboard#api-keys" target="_blank" rel="noopener" style="color:var(--accent-primary,#1a62b9);">api.paxsenix.org/dashboard</a></p>
              <p style="font-size:12px; color:var(--text-secondary,#ccc); line-height:1.5; margin:0 0 6px;"><span style="font-weight:700;">2.</span> Click <strong>Sign in with GitHub</strong> (create one if needed)</p>
              <p style="font-size:12px; color:var(--text-secondary,#ccc); line-height:1.5; margin:0 0 6px;"><span style="font-weight:700;">3.</span> Click <strong>Authorize paxsenix</strong> when prompted</p>
              <p style="font-size:12px; color:var(--text-secondary,#ccc); line-height:1.5; margin:0 0 6px;"><span style="font-weight:700;">4.</span> In the sidebar click <strong>API Keys</strong></p>
              <p style="font-size:12px; color:var(--text-secondary,#ccc); line-height:1.5; margin:0 0 6px;"><span style="font-weight:700;">5.</span> Click <strong>Copy Key</strong> at the bottom</p>
              <p style="font-size:12px; color:var(--text-secondary,#ccc); line-height:1.5; margin:0;"><span style="font-weight:700;">6.</span> Paste <code style="background:var(--bg-surface,#202020); padding:1px 5px; border-radius:3px; font-size:11px;">sk-paxsenix-…</code> into the field above and save</p>
            </div>

            <p style="margin-top:auto; padding-top:16px; font-size:11px; color:var(--text-subdued,#555); line-height:1.6; text-align:center;">For issues contact us on Discord. Try a VPN if domains are blocked. Include screenshots when reporting. Made with ❤️</p>

          </div>
        </div>
        
        <div id="qobuz-controls-area" class="qobuz-controls">
          <div class="qobuz-search-row">
            <div class="qobuz-input-wrapper">
              <div class="qobuz-input-icon">${ICONS.search}</div>
              <input type="text" id="qobuz-search-input" class="qobuz-input" placeholder="Search tracks, albums, artists...">
            </div>
            <div class="qobuz-tabs" id="qobuz-search-tabs">
              <button class="qobuz-tab active" data-type="track">Tracks</button>
              <button class="qobuz-tab" data-type="album">Albums</button>
              <button class="qobuz-tab" data-type="artist">Artists</button>
            </div>

          </div>
        </div>

        <div id="qobuz-content-area" class="qobuz-content"></div>
      `;
      document.body.appendChild(panel);

      panel.querySelector(".qobuz-close-btn").onclick = () => this.close();
      panel.querySelector("#qobuz-back-btn").onclick = () => this.goBack();

      // Settings panel 
      const settingsPanel = panel.querySelector("#qobuz-settings-panel");
      const keyInput      = panel.querySelector("#qobuz-pax-key-input");
      const keyStatus     = panel.querySelector("#qobuz-pax-key-status");

      const refreshKeyStatus = () => {
        const key = getPaxKey();
        if (key) {
          keyStatus.className = "qobuz-api-key-status ok";
          keyStatus.textContent = "✓ API key saved";
          keyInput.value = key;
        } else {
          keyStatus.className = "qobuz-api-key-status missing";
          keyStatus.textContent = "No API key saved. Streaming via Paxsenix will be unavailable.";
          keyInput.value = "";
        }
      };

      panel.querySelector("#qobuz-settings-btn").onclick = () => {
        refreshKeyStatus();
        settingsPanel.classList.add("open");
      };
      panel.querySelector(".qobuz-settings-close").onclick = () => {
        settingsPanel.classList.remove("open");
      };

      // API key steps toggle
      const apiKeyToggle = panel.querySelector("#qobuz-apikey-toggle");
      const apiKeySteps  = panel.querySelector("#qobuz-apikey-steps");
      const apiKeyArrow  = panel.querySelector("#qobuz-apikey-arrow");
      if (apiKeyToggle && apiKeySteps) {
        apiKeyToggle.onclick = () => {
          const open = apiKeySteps.style.display === "none";
          apiKeySteps.style.display = open ? "block" : "none";
          if (apiKeyArrow) apiKeyArrow.style.transform = open ? "rotate(180deg)" : "";
        };
      }
      panel.querySelector("#qobuz-pax-key-save").onclick = () => {
        const val = keyInput.value.trim();
        if (!val) {
          localStorage.removeItem("qobuz_pax_api_key");
          keyStatus.className = "qobuz-api-key-status missing";
          keyStatus.textContent = "API key cleared.";
          return;
        }
        localStorage.setItem("qobuz_pax_api_key", val);
        keyStatus.className = "qobuz-api-key-status ok";
        keyStatus.textContent = "✓ API key saved!";
        setTimeout(() => settingsPanel.classList.remove("open"), 800);
      };
      
      const input = panel.querySelector("#qobuz-search-input");

      input.addEventListener("input", (e) => {
        this._currentQuery = e.target.value.trim();
        this.handleSearch(e.target.value);
      });

      panel.querySelectorAll(".qobuz-tab").forEach(btn => {
        btn.onclick = () => {
          const container = document.getElementById("qobuz-content-area");
          const currentKey = `${this.state.searchType}:${this._currentQuery}`;
          if (container) this._scrollCache[currentKey] = container.scrollTop;

          this.state.searchType = btn.dataset.type;
          panel.querySelectorAll(".qobuz-tab").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          if (input.value) this.handleSearch(input.value);

          const newKey = `${this.state.searchType}:${this._currentQuery}`;
          const savedScroll = this._scrollCache[newKey];
          if (savedScroll !== undefined) {
            setTimeout(() => { if (container) container.scrollTop = savedScroll; }, 0);
          }
        };
      });
    },

    createPlayerBarButton() {
      if (document.getElementById("qobuz-search-btn")) return;
      const btn = document.createElement("button");
      btn.id = "qobuz-search-btn";
      btn.className = "qobuz-playerbar-btn";
      btn.innerHTML = `
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-9l6 4.5-6 4.5z"/></svg>
        <span>Qobuz</span>
      `;
      btn.onclick = () => this.open();
      if (this.api?.ui?.registerSlot) {
        this.api.ui.registerSlot("playerbar:menu", btn);
      }
    },

    // ═══════════════════════════════════════════════════════════════════
    // NAVIGATION
    // ═══════════════════════════════════════════════════════════════════

    open() {
      this.isOpen = true;
      document.getElementById("qobuz-search-overlay")?.classList.add("open");
      document.getElementById("qobuz-search-panel")?.classList.add("open");
      // Refresh library tracks so heart icons reflect any external changes
      this.fetchLibraryTracks();
      setTimeout(() => document.querySelector("#qobuz-search-input")?.focus(), 100);
    },

    close() {
      this.isOpen = false;
      document.getElementById("qobuz-search-overlay")?.classList.remove("open");
      document.getElementById("qobuz-search-panel")?.classList.remove("open");
      if (this.hasNewChanges) {
        this.api?.library?.refresh?.();
        this.hasNewChanges = false;
      }
      // Clear search cache so results are fresh on next open
      this.searchCache   = {};
      this._currentQuery = "";
    },

    navigateTo(view, data, title) {
      const container = document.getElementById("qobuz-content-area");
      const scrollKey = `${this.state.view}:${this.state.currentTitle}`;
      if (container) this._scrollCache[scrollKey] = container.scrollTop;

      // Capture current search input value so goBack can restore it
      const currentQuery = this.state.view === "search"
        ? (document.getElementById("qobuz-search-input")?.value ?? "")
        : null;

      this.state.history.push({
        view:       this.state.view,
        data:       this.state.currentData,
        title:      this.state.currentTitle,
        query:      currentQuery,
        searchType: this.state.view === "search" ? this.state.searchType : null,
      });
      this.state.view         = view;
      this.state.currentData  = data;
      this.state.currentTitle = title;
      this.updateHeader();
      this.render();
    },

    goBack(forceReset = false) {
      if (forceReset) {
        this.state.history = [];
        this.state.view = 'search';
        this.state.currentData = null;
        this.state.currentTitle = "Qobuz Search";
        this.updateHeader();
        this.render();
        return;
      }
      if (this.state.history.length > 0) {
        const prev = this.state.history.pop();
        this.state.view = prev.view;
        this.state.currentData = prev.data;
        this.state.currentTitle = prev.title;
        this.updateHeader();
        // Restore search state
        if (prev.view === "search") {
          const input = document.getElementById("qobuz-search-input");
          if (input) input.value = prev.query ?? "";
          if (prev.searchType) {
            this.state.searchType = prev.searchType;
            document.querySelectorAll(".qobuz-tab").forEach(b => {
              b.classList.toggle("active", b.dataset.type === prev.searchType);
            });
          }
        }
        this.render();
        const scrollKey = `${prev.view}:${prev.title}`;
        const savedScroll = this._scrollCache[scrollKey];
        if (savedScroll !== undefined) {
          const container = document.getElementById("qobuz-content-area");
          if (container) setTimeout(() => { container.scrollTop = savedScroll; }, 0);
        }
      } else {
        this.close();
      }
    },

    updateHeader() {
      const backBtn = document.getElementById("qobuz-back-btn");
      const title = document.getElementById("qobuz-panel-title");
      const controls = document.getElementById("qobuz-controls-area");
      title.textContent = this.state.currentTitle;
      if (this.state.view === 'search') {
        backBtn.classList.add("hidden");
        controls.classList.remove("hidden");
      } else {
        backBtn.classList.remove("hidden");
        controls.classList.add("hidden");
      }
    },

    // search registry handler
    // called by runtime when another plugin queries api.search.query
    // must call onResult exactly once with status success, not_found,error

    async handleSearchQuery(query, onResult) {
      try {
        const searchQuery = `${query.title} ${query.artist || ""}`.trim();

        // try each provider in priority order, stopping on first usable result

        // paxsenix
        const paxAuth = getPaxAuth();
        if (paxAuth) {
          try {
            const url = `https://api.paxsenix.org/qobuz/search?q=${encodeURIComponent(searchQuery)}`;
            const res = await (this.api.fetch
              ? this.api.fetch(url, { headers: { "Authorization": paxAuth, "Content-Type": "application/json" } })
              : fetch(url,          { headers: { "Authorization": paxAuth, "Content-Type": "application/json" } }));
            if (res.ok) {
              const data = await res.json();
              if (data.ok) {
                const items = (data.tracks || []).map(t => ({
                  id:          String(t.id),
                  title:       t.title + (t.version ? ` (${t.version})` : ""),
                  artist:      t.performer?.name || t.artist?.name || "Unknown Artist",
                  albumTitle:  t.album?.title    || "",
                  duration:    t.duration        || 0,
                  cover:       t.album?.image?.large || t.album?.image?.small || null,
                  bitDepth:    t.maximum_bit_depth     || null,
                  sampleRate:  t.maximum_sampling_rate || null,
                  isHiRes:     !!(t.hires_streamable),
                  trackNumber: t.track_number    || null,
                  discNumber:  t.media_number    || null,
                  isrc:        t.isrc            || null,
                  _source:     "paxsenix"
                }));

                const best = this._pickBestMatch(items, query);
                if (best) { onResult(this.qobuzTrackToSearchResult(best.track, best.score)); return; }
              }
            }
          } catch (e) {
            console.warn("[QobuzSearch] handleSearchQuery — Paxsenix failed:", e.message);
          }
        }

        // jumo-dl
        try {
          const url = `${JUMO_BASE}/search?query=${encodeURIComponent(searchQuery)}&offset=0&limit=20&region=NZ`;
          const res = await (this.api.fetch
            ? this.api.fetch(url, { headers: JUMO_HEADERS })
            : fetch(url, { headers: JUMO_HEADERS }));
          if (res.ok) {
            const data = await res.json();
            const items = (data.tracks?.items || []).map(t => ({
              id:          String(t.id),
              title:       t.title + (t.version ? ` (${t.version})` : ""),
              artist:      t.performer?.name || t.artist?.name || "Unknown Artist",
              albumTitle:  t.album?.title    || "",
              duration:    t.duration        || 0,
              cover:       t.album?.image?.large || t.album?.image?.small || null,
              bitDepth:    t.maximum_bit_depth     || null,
              sampleRate:  t.maximum_sampling_rate || null,
              isHiRes:     !!(t.hires_streamable),
              trackNumber: t.track_number    || null,
              discNumber:  t.media_number    || null,
              isrc:        t.isrc            || null,
              _source:     "jumo"
            }));

            const best = this._pickBestMatch(items, query);
            if (best) { onResult(this.qobuzTrackToSearchResult(best.track, best.score)); return; }
          }
        } catch (e) {
          console.warn("[QobuzSearch] handleSearchQuery — jumo-dl failed:", e.message);
        }

        // YAMS
        try {
          const url = `${YAMS_SEARCH_BASE}?query=${encodeURIComponent(searchQuery)}`;
          const res = await (this.api.fetch ? this.api.fetch(url) : fetch(url));
          if (res.ok) {
            const data = await res.json();
            const items = (data.tracks || [])
              .filter(t => t.platform === "qobuz")
              .map(t => ({
                id:         `qobuz:${t.id}`,
                title:       t.title,
                artist:      t.artist || "Unknown Artist",
                albumTitle:  t.album  || "",
                duration:    t.duration || 0,
                cover:       t.cover   || null,
                bitDepth:    null,
                sampleRate:  null,
                isHiRes:     false,
                isrc:        null,
                _source:     "yams"
              }));

            const best = this._pickBestMatch(items, query);
            if (best) { onResult(this.qobuzTrackToSearchResult(best.track, best.score)); return; }
          }
        } catch (e) {
          console.warn("[QobuzSearch] handleSearchQuery — YAMS failed:", e.message);
        }

        // all providers exhausted
        onResult({ sourceId: SOURCE_TYPE, status: "not_found" });
      } catch (err) {
        console.error("[QobuzSearch] handleSearchQuery error:", err);
        onResult({ sourceId: SOURCE_TYPE, status: "error", error: err });
      }
    },

    // score all candidates and return the best one above threshold, or null
    _pickBestMatch(items, query) {
      if (!items.length) return null;
      const scored = items
        .map(t => ({ track: t, score: this.calculateMatchScore(t, query) }))
        .sort((a, b) => b.score - a.score);
      return scored[0].score >= 60 ? scored[0] : null;
    },

    calculateMatchScore(track, query) {
      let score = 0;
      const n = (s) => (s || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();

      const tTitle = n(track.title);
      const qTitle = n(query.title);
      if (tTitle === qTitle) score += 50;
      else if (tTitle.includes(qTitle) || qTitle.includes(tTitle)) score += 30;

      const tArtist = n(track.artist);
      const qArtist = n(query.artist || "");
      if (tArtist === qArtist) score += 30;
      else if (tArtist.includes(qArtist) || qArtist.includes(tArtist)) score += 15;

      if (query.duration_ms && track.duration) {
        const diff = Math.abs(track.duration - query.duration_ms / 1000);
        if (diff < 5) score += 20;
        else if (diff < 10) score += 10;
      }

      if (track.isrc && query.isrc && track.isrc === query.isrc) score += 100;

      return score;
    },

    // normalize qobuz track object into a shared SearchResult
    qobuzTrackToSearchResult(track, score = 0) {
      const externalId = String(track.id).startsWith("qobuz:")
        ? String(track.id).split(":")[1]
        : String(track.id);

      const format = (track.bitDepth && track.sampleRate)
        ? `${track.bitDepth}bit/${track.sampleRate}kHz`
        : (track.isHiRes ? "Hi-Res" : "CD");

      return {
        sourceId:    SOURCE_TYPE,
        status:      "success",
        source_type: SOURCE_TYPE,
        external_id: externalId,
        title:       track.title,
        artist:      track.artist  || null,
        album:       track.albumTitle || null,
        duration:    track.duration   || null,
        cover_url:   track.cover      || null,
        album_art:   track.cover      || null,
        track_number: track.trackNumber || null,
        disc_number:  track.discNumber  || null,
        format,
        bitrate:     null,
        musicbrainz_recording_id: null,
        metadata_json: {
          isrc:        track.isrc        || null,
          bit_depth:   track.bitDepth    || null,
          sample_rate: track.sampleRate  || null,
          is_hi_res:   track.isHiRes     || false,
          provider:    track._source     || null,
        },
        score,
        raw: track,
      };
    },

    // ═══════════════════════════════════════════════════════════════════
    // DATA FETCHING
    // ═══════════════════════════════════════════════════════════════════

    handleSearch(query) {
      clearTimeout(this.searchTimeout);
      const container = document.getElementById("qobuz-content-area");
      if (!query.trim()) {
        this.searchCache   = {};
        this._scrollCache  = {};
        this._currentQuery = "";
        container.innerHTML = `<div class="text-center">Start typing to search</div>`;
        return;
      }
      const cacheKey = `${this.state.searchType}:${query.trim()}`;
      if (this.searchCache[cacheKey]) {
        this.state.currentData = this.searchCache[cacheKey];
        this.renderSearchResults(this.searchCache[cacheKey]);
        return;
      }
      this.renderSkeleton("search");
      this.searchTimeout = setTimeout(() => this.performSearch(query.trim()), 400);
    },

    async performSearch(query) {
      const container = document.getElementById("qobuz-content-area");
      const cacheKey  = `${this.state.searchType}:${query}`;

      if (this.searchCache[cacheKey]) {
        this.state.currentData = this.searchCache[cacheKey];
        this.renderSearchResults(this.searchCache[cacheKey]);
        return;
      }

      // ── Artist tab: use buildArtistData to search + filter, then extract
      //    a deduplicated list of matching artists to show as cards ────────────
      if (this.state.searchType === "artist") {

        // ── 0. Paxsenix — returns a proper artists[] with pictures ──────────
        const paxAuthArtist = getPaxAuth();
        if (paxAuthArtist) {
          try {
            const paxUrl = `https://api.paxsenix.org/qobuz/search?q=${encodeURIComponent(query)}`;
            const paxRes = await (this.api.fetch
              ? this.api.fetch(paxUrl, { headers: { "Authorization": paxAuthArtist, "Content-Type": "application/json" } })
              : fetch(paxUrl,          { headers: { "Authorization": paxAuthArtist, "Content-Type": "application/json" } }));
            if (!paxRes.ok) throw new Error("HTTP " + paxRes.status);
            const paxData = await paxRes.json();
            if (!paxData.ok) throw new Error(paxData.message || "Paxsenix returned ok: false");

            // Populate track + album cache keys from this single response
            this._populateCacheFromPaxSearch(paxData, query);

            const queryLower = query.toLowerCase();
            const artistItems = (paxData.artists || [])
              .filter(a => (a.name || "").toLowerCase().includes(queryLower))
              .map(a => ({
                id:          String(a.id),
                name:        a.name || "Unknown Artist",
                slug:        a.slug || null,
                albumsCount: a.albums_count || null,
                // Best available picture — extralarge → large → medium → small → picture fallback
                picture:     a.image?.mega || a.image?.extralarge || a.image?.large || a.image?.medium || a.image?.small || a.picture || null,
                _source:     "paxsenix"
              }));

            if (artistItems.length) {
                  this.searchCache[cacheKey] = artistItems;
              this.state.currentData = artistItems;
              this.renderSearchResults(artistItems);
              return;
            }
            console.warn(`[QobuzSearch] Paxsenix artist search returned 0 results for "${query}", falling through`);
          } catch (e) {
            console.warn("[QobuzSearch] Paxsenix artist tab search failed:", e.message);
          }
        }

        // ── 1. jumo-dl fallback (workaround) ───────────
        try {
          const url = `${JUMO_BASE}/search?query=${encodeURIComponent(query)}&offset=0&limit=50&region=NZ`;
          const res = await (this.api.fetch
            ? this.api.fetch(url, { headers: JUMO_HEADERS })
            : fetch(url, { headers: JUMO_HEADERS }));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();

          // Deduplicate artists from track results — each track has a performer object
          const seenIds = new Set();
          const artists = [];
          for (const t of (data.tracks?.items || [])) {
            const a = t.performer || t.artist;
            if (a?.id && !seenIds.has(a.id)) {
              seenIds.add(a.id);
              artists.push({ id: String(a.id), name: a.name || "Unknown Artist" });
            }
          }
          // Also pull artists from album results
          for (const a of (data.albums?.items || [])) {
            if (a.artist?.id && !seenIds.has(a.artist.id)) {
              seenIds.add(a.artist.id);
              artists.push({ id: String(a.artist.id), name: a.artist.name || "Unknown Artist" });
            }
          }

          // Filter to artists whose name contains the query (case-insensitive)
          // — looser than the artist page filter so partial names still surface
          const queryLower = query.toLowerCase();
          const filtered = artists.filter(a => a.name.toLowerCase().includes(queryLower));

          if (!filtered.length) {
            container.innerHTML = `<div class="text-center">No artists found</div>`;
            return;
          }

          this.searchCache[cacheKey] = filtered;
          this.state.currentData = filtered;
          this.renderSearchResults(filtered);
        } catch (err) {
          console.error("[QobuzSearch] Artist tab search error:", err);
          container.innerHTML = `<div class="text-center" style="color:#f55">Error: ${err.message}</div>`;
        }
        return;
      }

      try {
        let results = null;

        // ── 0. Paxsenix (all types, requires API key) ───────────────────────
        const paxAuthSearch = getPaxAuth();
        if (paxAuthSearch) {
          try {
            const paxUrl = `https://api.paxsenix.org/qobuz/search?q=${encodeURIComponent(query)}`;
            const paxRes = await (this.api.fetch
              ? this.api.fetch(paxUrl, { headers: { "Authorization": paxAuthSearch, "Content-Type": "application/json" } })
              : fetch(paxUrl,          { headers: { "Authorization": paxAuthSearch, "Content-Type": "application/json" } }));
            if (!paxRes.ok) throw new Error("HTTP " + paxRes.status);
            const paxData = await paxRes.json();
            if (!paxData.ok) throw new Error(paxData.message || "Paxsenix returned ok: false");

            // Populate all 3 cache keys from this single response
            this._populateCacheFromPaxSearch(paxData, query);

            results = this.searchCache[`${this.state.searchType}:${query}`] || null;
            if (!results?.length) results = null;
          } catch (e) {
            console.warn("[QobuzSearch] Paxsenix search failed:", e.message);
            results = null;
          }
        }

        // ── 1. jumo-dl (tracks + albums, no artist search) 
        if (!results && this.state.searchType !== "artist") {
          try {
            const url = `${JUMO_BASE}/search?query=${encodeURIComponent(query)}&offset=0&limit=50&region=NZ`;
            const res = await (this.api.fetch
              ? this.api.fetch(url, { headers: JUMO_HEADERS })
              : fetch(url, { headers: JUMO_HEADERS }));
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();

            const trackItems = data.tracks?.items || [];
            if (trackItems.length) {
              this.searchCache[`track:${query}`] = trackItems.map(t => ({
                id:           String(t.id),
                title:        t.title + (t.version ? ` (${t.version})` : ""),
                artist:       t.performer?.name || t.artist?.name || "Unknown Artist",
                artistId:     t.performer?.id   || t.artist?.id   || null,
                artistSlug:   t.album?.artist?.slug || null,
                albumTitle:   t.album?.title    || "",
                albumId:      t.album?.id  ? String(t.album.id)  : null,
                albumUpc:     t.album?.upc ? String(t.album.upc) : null,
                //just for future use
                duration:     t.duration        || 0,
                cover:        t.album?.image?.large || t.album?.image?.small || t.album?.image?.thumbnail || "",
                bitDepth:     t.maximum_bit_depth      || null,
                sampleRate:   t.maximum_sampling_rate  || null,
                audioQuality: t.maximum_bit_depth
                  ? `${t.maximum_bit_depth}bit / ${t.maximum_sampling_rate}kHz`
                  : (t.maximum_technical_specifications || ""),
                isHiRes:          !!(t.hires_streamable),
                trackNumber:      t.track_number  || null,
                discNumber:       t.media_number  || null,
                parental_warning: !!(t.parental_warning),
                _source:      "jumo"
              }));
            }

            const albumItems = data.albums?.items || [];
            if (albumItems.length) {
              this.searchCache[`album:${query}`] = albumItems.map(a => ({
                id:          String(a.id),          // slug (new albums) or UPC (old albums) — jumo-dl accepts both
                upc:         String(a.upc || a.id),  // real UPC when available; Paxsenix requires this
                title:       a.title,
                artist:      a.artist?.name || "Unknown Artist",
                artistId:    a.artist?.id   || null, // numeric, confirmed present in jumo-dl response
                artistSlug:  a.artist?.slug || null,
                cover:       a.image?.large || a.image?.small || a.image?.thumbnail || "",
                isHiRes:     !!(a.hires_streamable),
                tracksCount: a.tracks_count || null,
                releaseDate: a.release_date_original || null,
                genre:       a.genre?.name  || null,
                _source:     "jumo"
              }));
            }

            results = this.searchCache[`${this.state.searchType}:${query}`] || null;
          } catch (e) {
            console.warn("[QobuzSearch] jumo-dl search failed:", e.message);
            results = null;
          }
        }

        // ── 2. YAMS (tracks only, filter to qobuz platform) 
        if (!results && this.state.searchType === "track") {
          try {
            const url = `${YAMS_SEARCH_BASE}?query=${encodeURIComponent(query)}`;
            const res = await (this.api.fetch ? this.api.fetch(url) : fetch(url));
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data        = await res.json();
            const qobuzTracks = (data.tracks || []).filter(t => t.platform === "qobuz");
            if (qobuzTracks.length) {
              results = qobuzTracks.map(t => ({
                id:           `qobuz:${t.id}`,
                _rawId:       String(t.id),
                title:        t.title,
                artist:       t.artist || "Unknown Artist",
                artistId:     null,
                albumTitle:   t.album  || "",
                duration:     t.duration || 0,
                cover:        t.cover  || "",
                bitDepth:     null,
                sampleRate:   null,
                audioQuality: "",
                isHiRes:      false,
                _source:      "yams"
              }));
            }
          } catch (e) {
            console.warn("[QobuzSearch] YAMS search failed:", e.message);
          }
        }

        // ── 3. dabmusic (last resort, currently 403) 
        if (!results) {
          try {
            const url = `${DAB_BASE}/search?q=${encodeURIComponent(query)}&offset=0&type=${this.state.searchType}`;
            const res = await (this.api.fetch ? this.api.fetch(url) : fetch(url));
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            let items = [];
            if (this.state.searchType === "track")       items = data.tracks  || [];
            else if (this.state.searchType === "album")  items = data.albums  || [];
            else if (this.state.searchType === "artist") items = data.artists || [];
            if (!items.length && Array.isArray(data)) items = data;
            if (items.length) {
              results = items;
            }
          } catch (e) {
            console.warn("[QobuzSearch] dabmusic search failed:", e.message);
          }
        }

        if (!results?.length) {
          container.innerHTML = `<div class="text-center">No results found</div>`;
          return;
        }

        if (!this.searchCache[cacheKey]) {
          this.searchCache[cacheKey] = results;
        }
        this.state.currentData = results;
        this.renderSearchResults(results);
      } catch (err) {
        console.error("[QobuzSearch] Search error:", err);
        this.showToast("Search failed. Please try again.", true);
        container.innerHTML = `<div class="text-center" style="color:#f55">Error: ${err.message}</div>`;
      }
    },

    async fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await (this.api.fetch
          ? this.api.fetch(url, { ...options, signal: controller.signal })
          : fetch(url, { ...options, signal: controller.signal }));
      } finally {
        clearTimeout(timer);
      }
    },

    // Normalize a raw Paxsenix or jumo-dl album detail response into the shared shape
    _normalizeAlbumDetail(data, albumId) {
      const cover = data.image?.large || data.image?.small || data.image?.thumbnail || "";
      const trackItems         = data.tracks?.items || [];
      const expectedTrackCount = data.tracks_count  || null;

      // albums_same_artist — full discography from Paxsenix album detail
      // id  = numeric qobuz_id for jumo-dl
      // upc = UPC string for Paxsenix album detail endpoint
      // Both must come from their dedicated fields — a.id is an alphanumeric slug
      // on newer albums and is NOT valid for either provider
      const sameArtistAlbums = (data.albums_same_artist?.items || []).map(a => ({
        id:          String(a.id || ""),       // slug/UPC for jumo-dl
        qobuzId:     String(a.qobuz_id || ""), // numeric — kept for reference
        upc:         String(a.upc || ""),
        title:       a.title + (a.version ? ` (${a.version})` : ""),
        artist:      a.artist?.name || data.artist?.name || "Unknown Artist",
        artistId:    a.artist?.id   || data.artist?.id   || null,
        cover:       a.image?.large || a.image?.small || a.image?.thumbnail || "",
        isHiRes:     !!(a.hires_streamable),
        tracksCount: a.tracks_count || null,
        releaseDate: a.release_date_original || null,
        genre:       a.genre?.name  || null,
        _source:     "paxsenix"
      }));

      return {
        id:                 String(data.id || albumId),       // slug/UPC for jumo-dl
        upc:                String(data.upc || ""),
        title:              data.title        || "Unknown Album",
        version:            data.version      || null,
        artist:             data.artist?.name || "Unknown Artist",
        artistId:           data.artist?.id   || null,
        artistSlug:         data.artist?.slug || null,
        // All credited artists with roles — used for collaborative albums
        allArtists:         (data.artists || []).map(a => ({ id: a.id, name: a.name, roles: a.roles || [] })),
        cover,
        releaseDate:        data.release_date_original || data.released_at || null,
        releaseType:        data.release_type  || data.product_type || null,
        isHiRes:            !!(data.hires_streamable),
        bitDepth:           data.maximum_bit_depth     || null,
        sampleRate:         data.maximum_sampling_rate || null,
        genre:              data.genre?.name  || (data.genres_list?.[0]) || null,
        label:              data.label?.name  || null,
        copyright:          data.copyright    || null,
        description:        typeof data.description === "string" ? data.description : null,
        awards:             data.awards       || [],
        totalDuration:      data.duration     || null,
        expectedTrackCount: expectedTrackCount,
        sameArtistAlbums,
        tracks: trackItems.map(t => ({
          id:          String(t.id),
          title:       t.title + (t.version ? ` (${t.version})` : ""),
          artist:      t.performer?.name || data.artist?.name || "Unknown Artist",
          artistId:    t.performer?.id   || data.artist?.id   || null,
          artistSlug:  data.artist?.slug || null,
          albumTitle:  data.title        || "",
          albumId:     String(data.id  || ""),          // use id (UPC/slug) — qobuz_id causes HTTP 500
          albumUpc:    String(data.upc || ""),          // real UPC for Paxsenix detail lookup
          duration:    t.duration        || 0,
          cover,
          trackNumber: t.track_number    || null,
          discNumber:  t.media_number    || null,
          bitDepth:    t.maximum_bit_depth     || data.maximum_bit_depth     || null,
          sampleRate:  t.maximum_sampling_rate || data.maximum_sampling_rate || null,
          isHiRes:     !!(t.hires_streamable  ?? data.hires_streamable),
          parental_warning: !!(t.parental_warning),
          performers:  t.performers      || null,
          isrc:        t.isrc            || null,
        }))
      };
    },

    async fetchAlbumDetails(albumId) {
      this.renderSkeleton("album");

      // ── 0. Paxsenix — returns richer data + discography ──────────────────
      // Both Paxsenix and jumo-dl accept albumId directly (slug on new albums,
      // UPC string on old albums). qobuz_id (numeric) causes HTTP 500 on both.
      const paxAuth = getPaxAuth();
      if (paxAuth && albumId) {
        try {
          const paxUrl = `https://api.paxsenix.org/qobuz/album?id=${encodeURIComponent(albumId)}`;
          const paxRes = await this.fetchWithTimeout(
            paxUrl,
            { headers: { "Authorization": paxAuth, "Content-Type": "application/json" } },
            10000
          );
          if (!paxRes.ok) throw new Error("HTTP " + paxRes.status);
          const data = await paxRes.json();
          if (!data.ok) throw new Error(data.message || "Paxsenix returned ok: false");
          return this._normalizeAlbumDetail(data, albumId);
        } catch (e) {
          console.warn("[QobuzSearch] Paxsenix album detail failed:", e.message);
        }
      }

      // ── 1. jumo-dl fallback ────────────────────────
      try {
        const url = `${JUMO_BASE}/album?album_id=${albumId}&region=NZ`; // always use id (slug/UPC) — not upc override
        const res = await this.fetchWithTimeout(url, { headers: JUMO_HEADERS }, 10000);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        return this._normalizeAlbumDetail(data, albumId);
      } catch (err) {
        const msg = err.name === "AbortError"
          ? "Album details timed out — please try again"
          : "Could not load album. Please try again.";
        this.showToast(msg, true);
        console.error("[QobuzSearch] fetchAlbumDetails:", err);
        return null;
      }
    },

    async buildArtistData(artistId, artistName) {
      // Fire a jumo-dl search using the artist name as the query, then filter
      // both tracks and albums down to exact artist name matches.
      const query = artistName.trim();
      const cacheKey = `artist:${query}`;

      if (this.searchCache[cacheKey]) {
        return this.searchCache[cacheKey];
      }

      // ── 0. Paxsenix /qobuz/artist — full artist detail ──────────────────
      const paxAuth = getPaxAuth();
      if (paxAuth && artistId) {
        try {
          const paxUrl = `https://api.paxsenix.org/qobuz/artist?id=${encodeURIComponent(artistId)}`;
          const paxRes = await (this.api.fetch
            ? this.api.fetch(paxUrl, { headers: { "Authorization": paxAuth, "Content-Type": "application/json" } })
            : fetch(paxUrl,          { headers: { "Authorization": paxAuth, "Content-Type": "application/json" } }));
          if (!paxRes.ok) throw new Error("HTTP " + paxRes.status);
          const data = await paxRes.json();
          if (!data.ok) throw new Error(data.message || "Paxsenix returned ok: false");

          // ── Metadata ────────────────────────────────────────────────────────
          const artistPicture = data.image?.mega || data.image?.extralarge || data.image?.large || data.image?.medium || data.image?.small || data.picture || null;
          const albumsCount   = data.albums_count || null;
          const artistSlug    = data.slug || null;
          // Use full biography content, fall back to summary
          const description   = data.biography?.content || data.biography?.summary || null;

          // ── Tracks from search cache (artist endpoint has no tracks) ────────
          const nameLower  = artistName.toLowerCase();
          const cachedTracks = this.searchCache[`track:${query}`] || [];
          const tracks = cachedTracks.filter(t =>
            String(t.artistId) === String(artistId) ||
            (t.artist || "").toLowerCase() === nameLower
          );

          // ── tracks_appears_on — guest/feature appearances ───────────────────
          const appearsOn = (data.tracks_appears_on?.items || []).map(t => ({
            id:          String(t.id),
            title:       t.title + (t.version ? ` (${t.version})` : ""),
            artist:      t.performer?.name || artistName,
            artistId:    t.performer?.id   || artistId,
            albumTitle:  t.album?.title    || "",
            albumId:     t.album?.id       ? String(t.album.id)  : null,
            albumUpc:    t.album?.upc      ? String(t.album.upc) : null,
            duration:    t.duration        || 0,
            cover:       t.album?.image?.large || t.album?.image?.small || t.album?.image?.thumbnail || "",
            bitDepth:    t.maximum_bit_depth      || null,
            sampleRate:  t.maximum_sampling_rate  || null,
            isHiRes:     !!(t.hires_streamable),
            parental_warning: !!(t.parental_warning),
            _source:     "paxsenix"
          }));

          // ── Discography: merge albums + albums_without_last_release ──────────
          // Deduplicate by qobuz_id — keep one entry per unique ID,
          // preferring albums[] entries when both arrays have the same ID.
          const normalizeAlbum = a => ({
            id:          String(a.id || ""),       // slug/UPC — what jumo-dl expects
            qobuzId:     String(a.qobuz_id || ""), // numeric — kept for reference
            upc:         String(a.upc || ""),
            title:       a.title + (a.version ? ` (${a.version})` : ""),
            artist:      a.artist?.name || artistName,
            artistId:    a.artist?.id   || artistId,
            cover:       a.image?.large || a.image?.small || a.image?.thumbnail || "",
            isHiRes:     !!(a.hires_streamable),
            tracksCount: a.tracks_count || null,
            releaseDate: a.release_date_original || null,
            genre:       a.genre?.name  || null,
            label:       a.label?.name  || null,
            _source:     "paxsenix"
          });

          const seenIds  = new Set(); // deduplicates by qobuz_id (numeric), not slug
          const allAlbums = [];

          // ── album_last_release — pinned at top with Latest badge ─────────────
          const lastRelease = data.album_last_release
            ? { ...normalizeAlbum(data.album_last_release), isLatest: true }
            : null;
          if (lastRelease) {
            seenIds.add(lastRelease.qobuzId || lastRelease.id);
            allAlbums.push(lastRelease);
          }

          // albums[] first — gives us 100 entries
          for (const a of (data.albums?.items || [])) {
            const norm = normalizeAlbum(a);
            const dedupeKey = norm.qobuzId || norm.id;
            if (!seenIds.has(dedupeKey)) { seenIds.add(dedupeKey); allAlbums.push(norm); }
          }

          // albums_without_last_release — adds the ~10 non-overlapping ones
          for (const a of (data.albums_without_last_release?.items || [])) {
            const norm = normalizeAlbum(a);
            const dedupeKey = norm.qobuzId || norm.id;
            if (!seenIds.has(dedupeKey)) { seenIds.add(dedupeKey); allAlbums.push(norm); }
          }

          // ── Playlists — Qobuz editorial playlists featuring this artist ──────
          const playlists = (data.playlists || []).map(pl => ({
            id:          String(pl.id),
            name:        pl.name || artistName,
            tracksCount: pl.tracks_count || 0,
            duration:    pl.duration     || 0,
            owner:       pl.owner?.name  || "Qobuz",
            // 4-cover at 300px — best available image
            images:      pl.images300?.length ? pl.images300 : (pl.images150?.length ? pl.images150 : pl.images || []),
            tracks:      (pl.tracks?.items || []).map(t => ({
              id:          String(t.id),
              title:       t.title + (t.version ? ` (${t.version})` : ""),
              artist:      t.performer?.name || artistName,
              artistId:    t.performer?.id   || artistId,
              albumTitle:  t.album?.title    || "",
              albumId:     t.album?.id       ? String(t.album.id)  : null,
              albumUpc:    t.album?.upc      ? String(t.album.upc) : null,
              duration:    t.duration        || 0,
              cover:       t.album?.image?.large || t.album?.image?.small || t.album?.image?.thumbnail || "",
              bitDepth:    t.maximum_bit_depth     || null,
              sampleRate:  t.maximum_sampling_rate || null,
              isHiRes:     !!(t.hires_streamable),
              parental_warning: !!(t.parental_warning),
              _source:     "paxsenix"
            }))
          }));

          const result = { artistId, artistName, artistPicture, tracks, albums: allAlbums, appearsOn, playlists, albumsCount, artistSlug, description };
          this.searchCache[cacheKey] = result;
          return result;
        } catch (e) {
          console.warn("[QobuzSearch] Paxsenix artist detail failed:", e.message);
        }
      }

      // ── 1. jumo-dl fallback  ────────────
      try {
        const url = `${JUMO_BASE}/search?query=${encodeURIComponent(query)}&offset=0&limit=50&region=NZ`;
        const res = await (this.api.fetch
          ? this.api.fetch(url, { headers: JUMO_HEADERS })
          : fetch(url, { headers: JUMO_HEADERS }));
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        const nameLower = artistName.toLowerCase();

        const tracks = (data.tracks?.items || [])
          .filter(t => (t.performer?.name || t.artist?.name || "").toLowerCase() === nameLower)
          .map(t => ({
            id:           String(t.id),
            title:        t.title + (t.version ? ` (${t.version})` : ""),
            artist:       t.performer?.name || t.artist?.name || artistName,
            artistId:     t.performer?.id   || t.artist?.id   || artistId,
            artistSlug:   t.album?.artist?.slug || null,
            albumTitle:   t.album?.title    || "",
            albumId:      t.album?.id  ? String(t.album.id)  : null,
            albumUpc:     t.album?.upc ? String(t.album.upc) : null,
            duration:     t.duration        || 0,
            cover:        t.album?.image?.large || t.album?.image?.small || t.album?.image?.thumbnail || "",
            bitDepth:     t.maximum_bit_depth      || null,
            sampleRate:   t.maximum_sampling_rate  || null,
            audioQuality: t.maximum_bit_depth
              ? `${t.maximum_bit_depth}bit / ${t.maximum_sampling_rate}kHz`
              : (t.maximum_technical_specifications || ""),
            isHiRes:          !!(t.hires_streamable),
            trackNumber:      t.track_number  || null,
            discNumber:       t.media_number  || null,
            parental_warning: !!(t.parental_warning),
            _source: "jumo"
          }));

        const albums = (data.albums?.items || [])
          .filter(a => (a.artist?.name || "").toLowerCase() === nameLower)
          .map(a => ({
            id:          String(a.id),
            title:       a.title,
            artist:      a.artist?.name || artistName,
            cover:       a.image?.large || a.image?.small || a.image?.thumbnail || "",
            isHiRes:     !!(a.hires_streamable),
            tracksCount: a.tracks_count || null,
            _source:     "jumo"
          }));

        // Pull catalog-level artist metadata from the first matched item
        const firstTrack = (data.tracks?.items || []).find(t =>
          (t.performer?.name || "").toLowerCase() === nameLower ||
          (t.album?.artist?.name || "").toLowerCase() === nameLower
        );
        const firstAlbum = (data.albums?.items || []).find(a =>
          (a.artist?.name || "").toLowerCase() === nameLower
        );
        const artistMeta  = firstTrack?.album?.artist || firstAlbum?.artist || {};
        const albumsCount = artistMeta.albums_count || null;
        const artistSlug  = artistMeta.slug || null;

        const result = { artistId, artistName, tracks, albums, albumsCount, artistSlug };
        this.searchCache[cacheKey] = result;
        return result;

      } catch (err) {
        console.warn("[QobuzSearch] Artist search failed:", err.message);
        this.showToast("Could not load artist data.", true);
        return this._buildArtistFromCache(artistId, artistName);
      }
    },

    // Fallback: use existing cache entries if the live search fails
    _buildArtistFromCache(artistId, artistName) {
      const nameLower = artistName?.toLowerCase();
      const seenTrackIds = new Set();
      const seenAlbumIds = new Set();
      const tracks = [];
      const albums = [];

      for (const [key, items] of Object.entries(this.searchCache)) {
        if (!Array.isArray(items)) continue;
        if (key.startsWith("track:")) {
          for (const t of items) {
            if (String(t.artistId) === String(artistId) && !seenTrackIds.has(t.id)) {
              seenTrackIds.add(t.id);
              tracks.push(t);
            }
          }
        }
        if (key.startsWith("album:")) {
          for (const a of items) {
            if (a.artist?.toLowerCase() === nameLower && !seenAlbumIds.has(a.id)) {
              seenAlbumIds.add(a.id);
              albums.push(a);
            }
          }
        }
      }

      return { artistId, artistName, tracks, albums, albumsCount: null, artistSlug: null };
    },

    decodeManifest(data) {
      try {
        const { manifestMimeType, manifest: manifestB64 } = data;
        const manifestStr = atob(manifestB64);

        if (manifestMimeType === "application/json" || !manifestMimeType) {
          // Direct URL in JSON wrapper
          const parsed = JSON.parse(manifestStr);
          if (parsed.url) return parsed.url;
          if (parsed.urls?.[0]) return parsed.urls[0];
        } else if (manifestMimeType === "application/dash+xml") {
          const blob = new Blob([manifestStr], { type: "application/dash+xml" });
          return URL.createObjectURL(blob);
        }
        return null;
      } catch (err) {
        console.error("[QobuzSearch] Manifest decode error:", err);
        this.showToast("Stream format error. Try a different quality.", true);
        return null;
      }
    },

    // Normalizes a Paxsenix /qobuz/search response into the shared cache shape
    // used by all providers. Populates track:, album:, and artist: cache keys.
    _populateCacheFromPaxSearch(data, query) {
      const trackItems = data.tracks || [];
      if (trackItems.length) {
        this.searchCache[`track:${query}`] = trackItems.map(t => ({
          id:           String(t.id),
          title:        t.title + (t.version ? ` (${t.version})` : ""),
          artist:       t.performer?.name || t.artist?.name || "Unknown Artist",
          artistId:     t.performer?.id   || t.artist?.id   || null,
          artistSlug:   t.album?.artist?.slug || null,
          albumTitle:   t.album?.title    || "",
          albumId:      t.album?.id  ? String(t.album.id)  : null,
          albumUpc:     t.album?.upc ? String(t.album.upc) : null,
          duration:     t.duration        || 0,
          // Best quality cover: large → small → thumbnail
          cover:        t.album?.image?.large || t.album?.image?.small || t.album?.image?.thumbnail || "",
          bitDepth:     t.maximum_bit_depth      || null,
          sampleRate:   t.maximum_sampling_rate  || null,
          audioQuality: t.maximum_bit_depth
            ? `${t.maximum_bit_depth}bit / ${t.maximum_sampling_rate}kHz`
            : (t.maximum_technical_specifications || ""),
          isHiRes:          !!(t.hires_streamable),
          trackNumber:      t.track_number  || null,
          discNumber:       t.media_number  || null,
          parental_warning: !!(t.parental_warning),
          _source:      "paxsenix"
        }));
      }

      const albumItems = data.albums || [];
      if (albumItems.length) {
        this.searchCache[`album:${query}`] = albumItems.map(a => ({
          id:          String(a.id || ""),       // slug/UPC — what jumo-dl expects
          qobuzId:     String(a.qobuz_id || ""), // numeric — kept for Paxsenix detail if needed
          upc:         String(a.upc || ""),
          title:       a.title,
          artist:      a.artist?.name || "Unknown Artist",
          artistId:    a.artist?.id   || null,
          artistSlug:  a.artist?.slug || null,
          // Best quality cover: large → small → thumbnail
          cover:       a.image?.large || a.image?.small || a.image?.thumbnail || "",
          isHiRes:     !!(a.hires_streamable),
          tracksCount: a.tracks_count || null,
          releaseDate: a.release_date_original || null,
          genre:       a.genre?.name  || null,
          _source:     "paxsenix"
        }));
      }

      const artistItems = data.artists || [];
      if (artistItems.length) {
        this.searchCache[`artist:${query}`] = artistItems.map(a => ({
          id:          String(a.id),
          name:        a.name || "Unknown Artist",
          slug:        a.slug || null,
          albumsCount: a.albums_count || null,
          // Best quality picture: extralarge → large → medium → small → picture
          picture:     a.image?.mega || a.image?.extralarge || a.image?.large || a.image?.medium || a.image?.small || a.picture || null,
          _source:     "paxsenix"
        }));
      }
    },

    async fetchStream(trackId) {
      const rawId = String(trackId).startsWith("qobuz:")
        ? String(trackId).split(":")[1]
        : String(trackId);

      const selectedQuality = document.getElementById("qobuz-quality-select")?.value || DEFAULT_QUALITY;

      // Quality fallback order — try all providers per tier before dropping quality
      const QUALITY_FALLBACKS = {
        "Studio Quality": ["Hi-Res", "CD", "320kbps"],
        "Hi-Res":         ["CD", "320kbps"],
        "CD":             ["Hi-Res", "320kbps"],
        "320kbps":        ["CD", "Hi-Res"],
      };
      const qualitiesToTry = [selectedQuality, ...(QUALITY_FALLBACKS[selectedQuality] || [])];

      const paxAuth = getPaxAuth();
      if (!paxAuth) {
        this.showToast("⚙️ Add your Paxsenix API key in Settings to enable streaming", true, true);
      }

      for (const quality of qualitiesToTry) {
        // ── 1. Paxsenix 
        if (paxAuth) try {
          const qobuzUrl = encodeURIComponent(`https://open.qobuz.com/track/${rawId}`);
          const url = `${PAX_BASE}?url=${qobuzUrl}&quality=${encodeURIComponent(quality)}`;
          const res = await (this.api.fetch
            ? this.api.fetch(url, { headers: { "Authorization": paxAuth, "Content-Type": "application/json" } })
            : fetch(url,          { headers: { "Authorization": paxAuth, "Content-Type": "application/json" } }));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          if (!data.ok) throw new Error(data.message || "Paxsenix returned ok: false");

          // Handle both direct URL and manifest responses
          let streamUrl = data.directUrl || data.data?.directUrl || null;
          if (!streamUrl && data.manifest) streamUrl = this.decodeManifest(data);

          if (!streamUrl) throw new Error("No stream URL in Paxsenix response");
          if (streamUrl?.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(streamUrl), 5000);
          return { url: streamUrl, quality, source: "paxsenix" };
        } catch (e) {
          console.warn(`[QobuzSearch] Paxsenix failed @ ${quality}:`, e.message);
        }

        // ── 2. dabmusic 
        try {
          const url = `${DAB_BASE}/stream?trackId=${rawId}&quality=${encodeURIComponent(quality)}`;
          const res = await (this.api.fetch ? this.api.fetch(url) : fetch(url));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();

          let streamUrl = data.url || null;
          if (!streamUrl && data.manifest) streamUrl = this.decodeManifest(data);

          if (!streamUrl) throw new Error("No stream URL in dabmusic response");
          if (streamUrl?.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(streamUrl), 5000);
          return { url: streamUrl, quality, source: "dabmusic" };
        } catch (e) {
          console.warn(`[QobuzSearch] dabmusic failed @ ${quality}:`, e.message);
        }

      }

      throw new Error("[QobuzSearch] All providers and quality tiers exhausted");
    },

    // ═══════════════════════════════════════════════════════════════════
    // RENDERING
    // ═══════════════════════════════════════════════════════════════════

    renderSkeleton(type) {
      const container = document.getElementById("qobuz-content-area");
      const s = (w, h, r='4px') => `<div class="qobux-skeleton" style="width:${w};height:${h};border-radius:${r};flex-shrink:0;"></div>`;

      if (type === 'search' && this.state.searchType === 'track') {
        const row = `
          <div style="display:grid; grid-template-columns:48px 1fr auto auto; align-items:center; gap:12px; padding:6px 8px;">
            ${s('48px','48px')}
            <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
              ${s('60%','13px')}
              ${s('40%','11px')}
            </div>
            ${s('32px','11px')}
            ${s('16px','16px','50%')}
          </div>`;
        container.innerHTML = `<div class="qobuz-track-list">${Array(8).fill(row).join('')}</div>`;

      } else if (type === 'search' && this.state.searchType === 'artist') {
        const card = `
          <div style="padding:8px; text-align:center;">
            <div style="width:100%; aspect-ratio:1; background:#222; border-radius:50%; margin-bottom:8px; animation:qobux-pulse 1.5s infinite;"></div>
            <div style="display:flex; justify-content:center; margin-bottom:5px;">${s('70%','13px')}</div>
            <div style="display:flex; justify-content:center;">${s('40%','11px')}</div>
          </div>`;
        container.innerHTML = `<div class="qobuz-grid-list">${Array(8).fill(card).join('')}</div>`;

      } else if (type === 'search') {
        const card = `
          <div style="padding:8px;">
            <div style="aspect-ratio:1; background:#222; border-radius:6px; margin-bottom:6px; animation:qobux-pulse 1.5s infinite;"></div>
            ${s('80%','13px')}
            <div style="margin-top:5px;">${s('55%','11px')}</div>
          </div>`;
        container.innerHTML = `<div class="qobuz-grid-list">${Array(8).fill(card).join('')}</div>`;

      } else if (type === 'artist-detail') {
        const trackRow = `
          <div style="display:grid; grid-template-columns:48px 1fr auto auto; align-items:center; gap:12px; padding:6px 8px;">
            ${s('48px','48px')}
            <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
              ${s('55%','13px')}
              ${s('35%','11px')}
            </div>
            ${s('32px','11px')}
            ${s('16px','16px','50%')}
          </div>`;
        const albumCard = `
          <div style="padding:8px;">
            <div style="aspect-ratio:1; background:#222; border-radius:6px; margin-bottom:6px; animation:qobux-pulse 1.5s infinite;"></div>
            ${s('80%','13px')}
            <div style="margin-top:5px;">${s('55%','11px')}</div>
          </div>`;
        container.innerHTML = `
          <div class="qobuz-hero">
            ${s('160px','160px','50%')}
            <div style="flex:1; display:flex; flex-direction:column; justify-content:center; gap:10px;">
              ${s('25%','11px')}
              ${s('65%','26px')}
              ${s('45%','13px')}
              ${s('90px','28px','20px')}
            </div>
          </div>
          <div style="padding:8px 24px 4px;">${s('40%','14px')}</div>
          <div class="qobuz-track-list">${Array(5).fill(trackRow).join('')}</div>
          <div style="padding:8px 24px 4px; margin-top:8px;">${s('30%','14px')}</div>
          <div class="qobuz-grid-list">${Array(4).fill(albumCard).join('')}</div>
        `;

      } else if (type === 'album') {
        const trackRow = `
          <div style="display:grid; grid-template-columns:48px 1fr auto auto; align-items:center; gap:12px; padding:6px 8px;">
            ${s('48px','48px')}
            <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
              ${s('55%','13px')}
              ${s('35%','11px')}
            </div>
            ${s('32px','11px')}
            ${s('16px','16px','50%')}
          </div>`;
        container.innerHTML = `
          <div class="qobuz-hero">
            ${s('160px','160px','8px')}
            <div style="flex:1; display:flex; flex-direction:column; justify-content:center; gap:10px;">
              ${s('30%','11px')}
              ${s('70%','26px')}
              ${s('50%','13px')}
              ${s('90px','28px','20px')}
            </div>
          </div>
          <div class="qobuz-track-list">${Array(6).fill(trackRow).join('')}</div>
        `;
      }
    },

    render() {
      if (this.state.view === "search") {
        if (this.state.currentData)
          this.renderSearchResults(this.state.currentData);
      } else if (this.state.view === 'album') {
        this.renderAlbumView(this.state.currentData);
      } else if (this.state.view === 'artist') {
        this.renderArtistView(this.state.currentData);
      }
    },

    renderSearchResults(results) {
      const container = document.getElementById("qobuz-content-area");
      if (!results?.length) { container.innerHTML = `<div class="text-center">No results found</div>`; return; }
      if (this.state.searchType === 'track') {
        container.innerHTML = `<div class="qobuz-track-list">${results.map(t => this.renderTrackItem(t, false)).join('')}</div>`;
        this.attachTrackListeners(container, results);
      } else if (this.state.searchType === "artist") {
        container.innerHTML = `<div class="qobuz-grid-list">${results.map(a => this.renderArtistCard(a)).join("")}</div>`;
        this.attachArtistCardListeners(container, results);
      } else {
        container.innerHTML = `<div class="qobuz-grid-list">${results.map(item => this.renderCard(item, true)).join('')}</div>`;
        this.attachCardListeners(container, results, true);
      }
    },

    renderAlbumView(album) {
      const container = document.getElementById("qobuz-content-area");
      if (!album) {
        container.innerHTML = `<div class="qobuz-unavailable"><div class="qobuz-unavailable-icon">⚠️</div>Album details unavailable</div>`;
        return;
      }

      const badge = album.isHiRes ? '<span class="qobuz-badge">Hi-Res</span>' : "";
      const qualityInfo = album.bitDepth
        ? `${album.bitDepth}bit / ${album.sampleRate}kHz`
        : "";

      const releaseTypeLabel = album.releaseType
        ? album.releaseType.charAt(0).toUpperCase() + album.releaseType.slice(1).toLowerCase()
        : "Album";

      const totalDurationFormatted = album.totalDuration
        ? this.formatDuration(album.totalDuration)
        : null;

      const missingTracks = album.expectedTrackCount && album.tracks.length < album.expectedTrackCount
        ? album.expectedTrackCount - album.tracks.length
        : 0;

      container.innerHTML = `
        <div class="qobuz-hero">
          <img src="${this.escapeHtml(album.cover)}" class="qobuz-hero-cover" onerror="this.src='https://picsum.photos/200'">
          <div class="qobuz-hero-info">
            <div class="qobuz-hero-type">${releaseTypeLabel} ${badge}</div>
            <div class="qobuz-hero-title">${this.escapeHtml(album.title)}</div>
            ${album.version ? `<div style="font-size:13px; color:var(--text-secondary,#aaa); margin-top:-6px; margin-bottom:4px;">${this.escapeHtml(album.version)}</div>` : ""}
            <div class="qobuz-hero-meta">
              ${(album.allArtists && album.allArtists.length > 1)
                ? album.allArtists.map(a => `<span class="qobuz-clickable-artist" data-artist-id="${a.id}">${this.escapeHtml(a.name)}</span>`).join(` <span style="color:var(--text-subdued,#555);">&</span> `)
                : `<span class="qobuz-clickable-artist" data-artist-id="${album.artistId || ''}">${this.escapeHtml(album.artist)}</span>`
              } 
              • <span>${album.releaseDate ? album.releaseDate.split('-')[0] : '----'}</span> 
              • <span>${album.tracks.length} songs</span>
              ${totalDurationFormatted ? `• <span>${totalDurationFormatted}</span>` : ""}
              ${qualityInfo ? `• <span>${qualityInfo}</span>` : ""}
              ${album.genre  ? `• <span>${this.escapeHtml(album.genre)}</span>` : ""}
              ${album.label  ? `• <span>${this.escapeHtml(album.label)}</span>` : ""}
            </div>
            <button id="qobuz-save-all-btn" class="qobuz-save-all-btn">
               ${ICONS.download} ${this.saveAllLabel(album.tracks.length)}
            </button>
          </div>
        </div>
        ${album.description ? `
          <div style="padding:16px 24px 8px;">
            <p id="qobuz-album-desc" class="qobuz-description collapsed">${this.escapeHtml(album.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())}</p>
            <button class="qobuz-show-more-btn" id="qobuz-album-desc-toggle">Show more</button>
          </div>` : ""}

        ${(album.awards && album.awards.length) ? `
          <div style="padding:4px 24px 8px; font-size:12px; color:var(--accent-primary,#1a62b9);">
            🏆 ${album.awards.map(a => this.escapeHtml(a.name)).join(" • ")}
          </div>` : ""}

        ${album.copyright ? `
          <div style="padding:4px 24px 16px; font-size:11px; color:var(--text-subdued,#555);">
            ${this.escapeHtml(album.copyright)}
          </div>` : ""}

        <div class="qobuz-track-list">${album.tracks.map(t => this.renderTrackItem(t, true)).join("")}</div>
        ${missingTracks > 0 ? `
          <div class="qobuz-missing-warning">
            ⚠️ ${missingTracks} track${missingTracks > 1 ? "s" : ""} may be missing — Qobuz reports ${album.expectedTrackCount} total but only ${album.tracks.length} were returned.
          </div>` : ""}

        ${(album.sameArtistAlbums && album.sameArtistAlbums.length) ? `
          <div class="qobuz-section-header">More by ${this.escapeHtml(album.artist)}</div>
          <div class="qobuz-grid-list" id="qobuz-same-artist-albums"></div>` : ""}
      `;

      // Attach Listeners — handle single or multiple artists in hero
      container.querySelectorAll('.qobuz-hero .qobuz-clickable-artist').forEach(el => {
        el.onclick = () => {
          const id   = el.dataset.artistId;
          const name = el.textContent;
          if (id) this.loadArtistPage(id, name);
        };
      });

      container.querySelector("#qobuz-save-all-btn").onclick = () => this.saveAllTracks(album.tracks, album);
      this.attachTrackListeners(container, album.tracks);

      // Wire up "More by artist" discography grid — paginated
      if (album.sameArtistAlbums?.length) {
        this._renderPaginatedSection(
          "qobuz-same-artist-albums", album.sameArtistAlbums,
          a => this.renderCard(a, true),
          (c, visible) => this.attachCardListeners(c, visible, true)
        );
      }

      const descToggle = container.querySelector("#qobuz-album-desc-toggle");
      const descEl     = container.querySelector("#qobuz-album-desc");
      if (descToggle && descEl) {
        descToggle.onclick = () => {
          const collapsed = descEl.classList.toggle("collapsed");
          descToggle.textContent = collapsed ? "Show more" : "Show less";
        };
      }
    },

    // Renders a paginated section with a "Show more" button.
    // containerId   — the DOM id of the list container
    // items         — full array of items
    // renderFn      — function(item) → HTML string
    // attachFn      — function(container, visibleItems) → void (attaches listeners)
    // pageSize      — how many to show per page (default 20)
    _renderPaginatedSection(containerId, items, renderFn, attachFn, pageSize = 20) {
      const container = document.getElementById(containerId);
      if (!container) return;

      let shown = pageSize;

      const render = () => {
        const visible  = items.slice(0, shown);
        const remaining = items.length - shown;

        container.innerHTML = visible.map(renderFn).join("") + (remaining > 0
          ? `<div id="${containerId}-show-more" style="grid-column:1/-1; text-align:center; padding:16px 0;">
               <button style="background:transparent; border:1px solid var(--border-color,#444); color:var(--text-secondary,#aaa); padding:8px 24px; border-radius:20px; font-size:13px; cursor:pointer;">
                 Show ${Math.min(remaining, pageSize)} more <span style="color:var(--text-subdued,#666);">(${remaining} left)</span>
               </button>
             </div>`
          : "");

        attachFn(container, visible);

        const btn = document.getElementById(`${containerId}-show-more`);
        if (btn) {
          btn.querySelector("button").onclick = () => {
            shown += pageSize;
            render();
            // Scroll the new button into view if there are more
            const next = document.getElementById(`${containerId}-show-more`);
            if (next) next.scrollIntoView({ behavior: "smooth", block: "nearest" });
          };
        }
      };

      render();
    },

    renderArtistView(data) {
      const container = document.getElementById("qobuz-content-area");

      const {
        artistName, tracks = [], albums = [],
        albumsCount = null, artistPicture = null,
        description = null, appearsOn = [], playlists = []
      } = data || {};

      // Hero avatar — real photo if available, otherwise initials
      const initials = (artistName || "?")
        .split(" ").slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("");
      const avatarHtml = artistPicture
        ? `<div class="qobuz-artist-avatar" style="padding:0; overflow:hidden;" aria-label="${this.escapeHtml(artistName || "Artist")}">
             <img src="${this.escapeHtml(artistPicture)}"
               style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;"
               onerror="this.parentElement.innerHTML='${this.escapeHtml(initials)}';this.parentElement.style.padding='';">
           </div>`
        : `<div class="qobuz-artist-avatar" aria-label="${this.escapeHtml(artistName || "Artist")}">${this.escapeHtml(initials)}</div>`;

      // Use albums directly (already contains merged discography from artist detail endpoint)
      const discography = albums;

      const statParts = [];
      if (tracks.length) statParts.push(`${tracks.length} track${tracks.length !== 1 ? "s" : ""} in results`);

      const hiResCount = tracks.filter(t => t.isHiRes).length;
      const qualityNote = hiResCount > 0
        ? `${hiResCount} Hi-Res track${hiResCount !== 1 ? "s" : ""} available`
        : "";

      // Strip HTML tags from description for safe display
      const cleanDescription = description
        ? description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
        : null;

      // Render static skeleton — paginated sections filled in after
      container.innerHTML = `
        <div class="qobuz-hero">
          ${avatarHtml}
          <div class="qobuz-hero-info">
            <div class="qobuz-hero-type">Artist</div>
            <div class="qobuz-hero-title">${this.escapeHtml(artistName || "Unknown Artist")}</div>
            <div class="qobuz-hero-meta">
              ${statParts.map(p => `<span>${p}</span>`).join(" • ")}
              ${qualityNote ? `<span style="color:var(--accent-primary,#1a62b9);">${qualityNote}</span>` : ""}
            </div>
            ${albumsCount ? `<div style="font-size:12px; color:var(--text-subdued,#666); margin-top:4px;">${albumsCount} albums on Qobuz</div>` : ""}
            ${tracks.length ? `
              <button id="qobuz-artist-save-all-btn" class="qobuz-save-all-btn">
                ${ICONS.download} ${this.saveAllLabel(tracks.length)}
              </button>
            ` : ""}
          </div>
        </div>

        ${cleanDescription ? `
          <div style="padding:0 24px 16px;">
            <p id="qobuz-artist-bio" class="qobuz-description collapsed">${this.escapeHtml(cleanDescription)}</p>
            <button class="qobuz-show-more-btn" id="qobuz-bio-toggle">Show more</button>
          </div>
        ` : ""}

        ${tracks.length ? `
          <div class="qobuz-section-header">Top Tracks</div>
          <div class="qobuz-track-list" id="qobuz-artist-tracks"></div>
        ` : ""}

        ${playlists.length ? `
          <div class="qobuz-section-header">Best of ${this.escapeHtml(artistName)}</div>
          ${playlists.map((pl, i) => `
            <div style="padding:0 24px 8px; display:flex; align-items:center; justify-content:space-between; gap:12px;">
              <span style="font-size:12px; color:var(--text-subdued,#666);">
                ${pl.tracksCount} tracks • ${this.formatDuration(pl.duration)} • by ${this.escapeHtml(pl.owner)}
              </span>
              <button class="qobuz-save-all-btn qobuz-save-playlist-btn" data-playlist-index="${i}" style="margin-top:0; flex-shrink:0;">
                ${ICONS.download} Save as Playlist
              </button>
            </div>
            <div class="qobuz-track-list" id="qobuz-artist-playlist-${i}"></div>
          `).join("")}
        ` : ""}

        ${discography.length ? `
          <div class="qobuz-section-header">Discography</div>
          <div class="qobuz-grid-list" id="qobuz-artist-albums"></div>
        ` : ""}

        ${appearsOn.length ? `
          <div class="qobuz-section-header">Also Featured In</div>
          <div class="qobuz-track-list" id="qobuz-artist-appears-on"></div>
        ` : ""}

        ${!tracks.length && !discography.length && !appearsOn.length && !playlists.length ? `
          <div class="qobuz-unavailable">
            <div class="qobuz-unavailable-icon">🎤</div>
            <div>No data found for this artist in the current search session.</div>
            <div style="margin-top:8px; font-size:12px;">Search for their name or album title to populate this page.</div>
          </div>
        ` : ""}
      `;

      // ── Paginated sections ────────────────────────────────────────────────
      if (tracks.length) {
        this._renderPaginatedSection(
          "qobuz-artist-tracks", tracks,
          t => this.renderTrackItem(t, false),
          (c, visible) => this.attachTrackListeners(c, visible)
        );
      }

      if (discography.length) {
        this._renderPaginatedSection(
          "qobuz-artist-albums", discography,
          a => this.renderCard(a, true),
          (c, visible) => this.attachCardListeners(c, visible, true)
        );
      }

      if (appearsOn.length) {
        this._renderPaginatedSection(
          "qobuz-artist-appears-on", appearsOn,
          t => this.renderTrackItem(t, false),
          (c, visible) => this.attachTrackListeners(c, visible)
        );
      }

      playlists.forEach((pl, i) => {
        if (pl.tracks.length) {
          this._renderPaginatedSection(
            `qobuz-artist-playlist-${i}`, pl.tracks,
            t => this.renderTrackItem(t, false),
            (c, visible) => this.attachTrackListeners(c, visible)
          );
        }

        const saveBtn = container.querySelector(`.qobuz-save-playlist-btn[data-playlist-index="${i}"]`);
        if (saveBtn) {
          saveBtn.onclick = () => this.saveAsPlaylist(pl);
        }
      });

      const artistSaveAllBtn = container.querySelector("#qobuz-artist-save-all-btn");
      if (artistSaveAllBtn) artistSaveAllBtn.onclick = () => this.saveAllTracks(tracks);

      const bioToggle = container.querySelector("#qobuz-bio-toggle");
      const bioEl     = container.querySelector("#qobuz-artist-bio");
      if (bioToggle && bioEl) {
        bioToggle.onclick = () => {
          const collapsed = bioEl.classList.toggle("collapsed");
          bioToggle.textContent = collapsed ? "Show more" : "Show less";
        };
      }
    },

    renderTrackItem(track, isCompact = false) {
      
      const isPlaying = this.isPlaying === String(track.id);
      const isSaved   = this.libraryTracks.has(String(track.id));
      const coverUrl  = track.cover || track.albumCover || "";

      const qualityLabel = track.bitDepth && track.sampleRate
        ? `${track.bitDepth}bit / ${track.sampleRate}kHz`
        : (track.audioQuality || "");

      const hiresBadge = track.isHiRes
        ? `<span class="qobuz-badge" style="font-size:9px; padding:1px 5px; flex-shrink:0;">Hi-Res</span>`
        : "";

      const explicitBadge = track.parental_warning
        ? `<span class="qobuz-explicit-badge">E</span>`
        : "";

      return `
        <div class="qobuz-track-item ${isPlaying ? 'playing' : ''}" data-id="${track.id}">
          <div class="qobuz-track-cover-wrapper">
            ${isCompact && track.trackNumber
              ? `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--text-subdued,#666);font-variant-numeric:tabular-nums;">${track.trackNumber}</div>`
              : `<img src="${this.escapeHtml(coverUrl)}" class="qobuz-track-cover" loading="lazy" onerror="this.style.display='none'">`
            }
            <div class="qobuz-play-overlay">${isPlaying ? ICONS.play : ''}</div>
          </div>
          <div style="min-width:0;">
            <div class="qobuz-track-title">
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;">${this.escapeHtml(track.title)}</span>
              ${hiresBadge}
              ${explicitBadge}
            </div>
            ${!isCompact
              ? `<div class="qobuz-track-artist">
                  <span class="qobuz-clickable-artist" data-artist-id="${track.artistId || ""}">${this.escapeHtml(track.artist)}</span>
                  ${track.albumTitle ? `<span style="color:var(--text-subdued,#666); font-size:11px; margin:0 3px; line-height:1;">·</span><span class="qobuz-clickable-album" data-album-id="${track.albumId || ""}" data-album-upc="${track.albumUpc || ""}">${this.escapeHtml(track.albumTitle)}</span>` : ""}
                  ${qualityLabel ? `<span style="color:var(--text-subdued,#666); font-size:11px; margin:0 3px; line-height:1;">·</span><span style="color:var(--text-subdued,#555); font-size:11px;">${this.escapeHtml(qualityLabel)}</span>` : ""}
                </div>`
              : (qualityLabel ? `<div style="font-size:11px; color:var(--text-subdued,#555); margin-top:2px;">${this.escapeHtml(qualityLabel)}</div>` : "")}
          </div>
          ${!isCompact ? `<div class="qobuz-track-time">${this.formatDuration(track.duration)}</div>` : ""}
          <div class="qobuz-track-actions">
             <button class="qobuz-save-btn-mini ${isSaved ? 'saved' : ''}" title="${isSaved ? 'Saved to Library' : 'Add to Library'}">
                ${isSaved ? ICONS.heart : ICONS.heartOutline}
             </button>
          </div>
        </div>
      `;
    },

    renderCard(item, isAlbum) {
      const imgUrl = isAlbum
        ? (item.cover || "")
        : (item.image || `https://ui-avatars.com/api/?name=${encodeURIComponent(item.name || "")}&background=333&color=fff`);
      const title      = isAlbum ? item.title : item.name;
      const artistText = isAlbum ? item.artist : (item.albumsCount || "Artist");
      const trackCount = isAlbum && item.tracksCount ? `${item.tracksCount} tracks` : null;

      const hiresBadge = (isAlbum && item.isHiRes)
        ? `<span class="qobuz-badge" style="font-size:9px; padding:1px 5px; flex-shrink:0;">Hi-Res</span>`
        : "";
      const latestBadge = (isAlbum && item.isLatest)
        ? `<span class="qobuz-badge" style="font-size:9px; padding:1px 5px; flex-shrink:0; background:var(--text-secondary,#aaa); color:#000;">New</span>`
        : "";

      return `
        <div class="qobuz-card" data-id="${item.id}">
          <img src="${this.escapeHtml(imgUrl)}" class="qobuz-card-img" loading="lazy">
          <div class="qobuz-card-title">${this.escapeHtml(title)}</div>
          <div class="qobuz-card-sub">
            ${(isAlbum && item.artistId)
              ? `<span class="qobuz-card-sub-text qobuz-clickable-artist" data-artist-id="${item.artistId}">${this.escapeHtml(artistText)}</span>`
              : `<span class="qobuz-card-sub-text">${this.escapeHtml(artistText)}</span>`
            }
            ${trackCount ? `<span class="qobuz-card-sub-count">• ${trackCount}</span>` : ""}
            ${hiresBadge}${latestBadge}
          </div>
        </div>
      `;
    },

    renderArtistCard(artist) {
      const initials = (artist.name || "?")
        .split(" ").slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("");
      // If a picture URL is available (Paxsenix), render an img that falls back
      // to the initials div if the image fails to load
      const avatarHtml = artist.picture
        ? `<div class="qobuz-artist-card-avatar" style="padding:0; overflow:hidden;">
             <img src="${this.escapeHtml(artist.picture)}"
               style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;"
               onerror="this.parentElement.innerHTML='${this.escapeHtml(initials)}';this.parentElement.style.padding='';">
           </div>`
        : `<div class="qobuz-artist-card-avatar">${this.escapeHtml(initials)}</div>`;
      const subText = artist.albumsCount
        ? `${artist.albumsCount} albums`
        : "Artist";
      return `
        <div class="qobuz-card qobuz-artist-card" data-id="${artist.id}">
          ${avatarHtml}
          <div class="qobuz-card-title">${this.escapeHtml(artist.name)}</div>
          <div class="qobuz-card-sub"><span class="qobuz-card-sub-text">${subText}</span></div>
        </div>
      `;
    },

    attachArtistCardListeners(container, artists) {
      container.querySelectorAll(".qobuz-artist-card").forEach((el) => {
        el.onclick = () => {
          const artist = artists.find(a => String(a.id) === String(el.dataset.id));
          if (artist) this.loadArtistPage(artist.id, artist.name);
        };
      });
    },

    attachTrackListeners(container, tracks) {
      container.querySelectorAll('.qobuz-track-item').forEach((el) => {
        el.onclick = (e) => {
          const artistClick = e.target.closest('.qobuz-clickable-artist');
          if (artistClick) {
            const artistId = artistClick.dataset.artistId;
            const artistName = artistClick.textContent;
            if (artistId) this.loadArtistPage(artistId, artistName);
            return;
          }
          const albumClick = e.target.closest('.qobuz-clickable-album');
          if (albumClick) {
            const albumId    = albumClick.dataset.albumId;
            const albumTitle = albumClick.textContent.trim();
            if (albumId) this.loadAlbumPage(albumId, albumTitle);
            return;
          }
          const track = tracks.find(t => String(t.id) === String(el.dataset.id));
          if (!track) return;
          const saveBtn = e.target.closest('.qobuz-save-btn-mini');
          if (saveBtn) { this.saveTrack(track, saveBtn); return; }
          this.playTrack(track);
        };
      });
    },

    attachCardListeners(container, items, isAlbum) {
      container.querySelectorAll(".qobuz-card").forEach((el) => {
        el.onclick = (e) => {
          // Artist name click inside album card
          const artistClick = e.target.closest(".qobuz-clickable-artist");
          if (artistClick) {
            e.stopPropagation();
            const id   = artistClick.dataset.artistId;
            const name = artistClick.textContent.trim();
            if (id) this.loadArtistPage(id, name);
            return;
          }
          const item = items.find(i => String(i.id) === String(el.dataset.id));
          if (!item) return;
          if (isAlbum) this.loadAlbumPage(item.id, item.title);
          else this.loadArtistPage(item.id, item.name);
        };
      });
    },

    async loadAlbumPage(id, title) {
      document.getElementById("qobuz-controls-area")?.classList.add("hidden");
      this.showToast("Loading Album...");
      const albumData = await this.fetchAlbumDetails(id);
      this.navigateTo("album", albumData, albumData?.title || title);
    },

    async loadArtistPage(id, name) {
      document.getElementById("qobuz-controls-area")?.classList.add("hidden");
      this.renderSkeleton("artist-detail");
      const artistData = await this.buildArtistData(id, name);
      this.navigateTo("artist", artistData, name);
    },

    // ═══════════════════════════════════════════════════════════════════
    // ACTIONS
    // ═══════════════════════════════════════════════════════════════════

    async playTrack(track) {
      try {
        const streamData = await this.fetchStream(track.id);
        if (!streamData?.url) throw new Error("No stream URL");

        this.isPlaying = String(track.id);
        document.querySelectorAll(".qobuz-track-item").forEach(el => {
          el.classList.toggle("playing", el.dataset.id === String(track.id));
        });

        const qualityLabel = track.bitDepth && track.sampleRate
          ? `${track.bitDepth}bit / ${track.sampleRate}kHz`
          : (track.audioQuality || streamData.quality || DEFAULT_QUALITY);

        if (this.api?.player?.setTrack) {
          this.api.player.setTrack({
            id:          track.id,
            path:        streamData.url,
            source_type: SOURCE_TYPE,
            title:       track.title,
            artist:      track.artist,
            album:       track.albumTitle  || null,
            duration:    track.duration    || null,
            cover_url:   track.cover || track.albumCover || null,
            format:      qualityLabel,
          });
        }

        this.updateNowPlaying(track);
        this.showToast(`▶ ${track.title} [${qualityLabel}]`);
      } catch (err) {
        console.error("[QobuzSearch] Playback error:", err);
        this.showToast("Playback failed — no stream available for this track.", true);
      }
    },

    async saveTrack(track, btn) {
      try {
        const result = this.qobuzTrackToSearchResult(track);
        if (this.libraryTracks.has(result.external_id)) {
          this.showToast("Already in library");
          return;
        }
        if (this.api?.library?.addExternalTrack) {
          await this.api.library.addExternalTrack(result);
          this.libraryTracks.add(result.external_id);
          if (btn) { btn.classList.add("saved"); btn.innerHTML = ICONS.heart; btn.title = "Saved to Library"; }
          this.showToast(`Saved: ${track.title}`);
          this.hasNewChanges = true;
        }
      } catch (e) {
        console.error("[QobuzSearch] saveTrack error:", e);
        this.showToast("Error saving track", true);
      }
    },

    async saveAllTracks(tracks, albumData = null) {
      if (!tracks?.length) { this.showToast("No tracks to save", true); return; }

      const progressEl   = document.getElementById("qobuz-save-progress");
      const progressBar  = progressEl?.querySelector(".qobuz-progress-bar-inner");
      const progressText = progressEl?.querySelector(".qobuz-progress-text");
      if (progressEl) progressEl.classList.remove("hidden");

      let savedCount = 0, skippedCount = 0, errorCount = 0;

      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];

        // Update progress bar
        const pct = ((i + 1) / tracks.length) * 100;
        if (progressBar)  progressBar.style.width = `${pct}%`;
        if (progressText) progressText.textContent = `Saving ${i + 1} of ${tracks.length} tracks...`;

        const result = this.qobuzTrackToSearchResult(
          albumData ? { ...track, albumTitle: track.albumTitle || albumData.title, cover: track.cover || albumData.cover, artist: track.artist || albumData.artist } : track
        );

        if (this.libraryTracks.has(result.external_id)) { skippedCount++; continue; }

        try {
          if (this.api?.library?.addExternalTrack) {
            await this.api.library.addExternalTrack(result);
            this.libraryTracks.add(result.external_id);
            savedCount++;

            // Update heart icon if row is visible
            const row = document.querySelector(`.qobuz-track-item[data-id="${track.id}"]`);
            if (row) {
              const btn = row.querySelector(".qobuz-save-btn-mini");
              if (btn) { btn.classList.add("saved"); btn.innerHTML = ICONS.heart; btn.title = "Saved to Library"; }
            }
          }
        } catch (e) {
          console.error("[QobuzSearch] Failed to save track", track.id, e);
          errorCount++;
        }

        await new Promise(r => setTimeout(r, 50));
      }

      if (progressEl) progressEl.classList.add("hidden");
      if (progressBar) progressBar.style.width = "0%";

      if (errorCount === 0) {
        this.showToast(skippedCount > 0
          ? `✓ Saved ${savedCount} tracks (${skippedCount} already in library)`
          : `✓ Saved all ${savedCount} tracks to library`);
      } else {
        this.showToast(`Saved ${savedCount} tracks, ${errorCount} failed`, errorCount > savedCount / 2);
      }

      this.hasNewChanges = true;
      if (this.api?.library?.refresh) await this.api.library.refresh();
    },

    async saveAsPlaylist(pl) {
      if (!pl?.tracks?.length) { this.showToast("No tracks to save", true); return; }

      const progressEl   = document.getElementById("qobuz-save-progress");
      const progressBar  = progressEl?.querySelector(".qobuz-progress-bar-inner");
      const progressText = progressEl?.querySelector(".qobuz-progress-text");
      if (progressEl) progressEl.classList.remove("hidden");
      if (progressText) progressText.textContent = `Creating playlist "${pl.name}"...`;

      try {
        // ── 1. Create playlist ───────────────────────────────────────────────
        const rawPlaylistId = await this.api.library.createPlaylist(pl.name);
        if (!rawPlaylistId) throw new Error("createPlaylist returned no ID");
        const playlistId = Number(rawPlaylistId); // runtime requires a number
        if (isNaN(playlistId)) throw new Error("createPlaylist returned non-numeric ID: " + rawPlaylistId);

        // ── 2. Set cover — use best available image ──────────────────────────
        const coverUrl = (pl.images || [])[0] || null;
        if (coverUrl && this.api.library.updatePlaylistCover) {
          await this.api.library.updatePlaylistCover(playlistId, coverUrl);
        }

        // ── 3 & 4. Save each track then add to playlist ──────────────────────
        let savedCount = 0, skippedCount = 0, errorCount = 0;
        const tracks = pl.tracks;

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];

          const pct = ((i + 1) / tracks.length) * 100;
          if (progressBar)  progressBar.style.width = `${pct}%`;
          if (progressText) progressText.textContent = `Adding ${i + 1} of ${tracks.length} tracks...`;

          const externalId = String(track.id).startsWith("qobuz:")
            ? String(track.id).split(":")[1]
            : String(track.id);

          if (this.libraryTracks.has(externalId)) { skippedCount++; continue; }

          try {
            // addExternalTrack returns the internal DB track ID
            const result = this.qobuzTrackToSearchResult(track);
            const trackId = await this.api.library.addExternalTrack(result);

            if (trackId && this.api.library.addTrackToPlaylist) {
              await this.api.library.addTrackToPlaylist(playlistId, Number(trackId));
            }

            this.libraryTracks.add(externalId);
            savedCount++;
          } catch (e) {
            console.error("[QobuzSearch] saveAsPlaylist — failed track", track.id, e);
            errorCount++;
          }

          await new Promise(r => setTimeout(r, 50));
        }

        // ── 5. Refresh library ───────────────────────────────────────────────
        if (this.api?.library?.refresh) await this.api.library.refresh();

        if (progressEl) progressEl.classList.add("hidden");
        if (progressBar) progressBar.style.width = "0%";

        this.showToast(errorCount === 0
          ? (skippedCount > 0
            ? `✓ Playlist "${pl.name}" saved (${savedCount} new, ${skippedCount} already in library)`
            : `✓ Playlist "${pl.name}" saved (${savedCount} tracks)`)
          : `Playlist saved — ${savedCount} tracks, ${errorCount} failed`, errorCount > 0);

      } catch (err) {
        if (progressEl) progressEl.classList.add("hidden");
        if (progressBar) progressBar.style.width = "0%";
        console.error("[QobuzSearch] saveAsPlaylist failed:", err);
        this.showToast("Failed to create playlist", true);
      }
    },

    async searchCoverForRPC(title, artist, trackId) {
      const tag = "[QobuzSearch:searchCoverForRPC]";
      try {
        const query = `${title} ${artist}`.trim();

        const url = `${JUMO_BASE}/search?query=${encodeURIComponent(query)}&offset=0&limit=10&region=NZ`;
        const res = await (this.api.fetch
          ? this.api.fetch(url, { headers: JUMO_HEADERS })
          : fetch(url, { headers: JUMO_HEADERS }));
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        const items = data.tracks?.items || [];
        if (!items.length) { console.warn(`${tag} No results for "${query}"`); return null; }

        const cover = items[0].album?.image?.large
          || items[0].album?.image?.small
          || items[0].album?.image?.thumbnail
          || null;

        if (!cover) { console.warn(`${tag} First result has no cover`); return null; }

        // Update database if trackId provided
        if (trackId && this.api.library?.updateTrackCoverUrl) {
          try {
            await this.api.library.updateTrackCoverUrl(trackId, cover);
          } catch (err) {
            console.warn(`${tag} Could not update database:`, err);
          }
        }

        return cover;
      } catch (err) {
        console.error(`${tag} Error:`, err);
        return null;
      }
    },

    updateNowPlaying(track) {
      const trackTitle  = document.querySelector(".now-playing .track-title, .track-info .title");
      const trackArtist = document.querySelector(".now-playing .track-artist, .track-info .artist");
      const albumArt    = document.querySelector(".now-playing .album-art img, .album-art img");
      if (trackTitle)  trackTitle.textContent  = track.title;
      if (trackArtist) trackArtist.textContent = track.artist || "";
      if (albumArt && (track.cover || track.albumCover)) albumArt.src = track.cover || track.albumCover;
    },

    showToast(msg, isError = false, withSettingsLink = false) {
      const toast = document.createElement("div");
      toast.style.cssText = `position:fixed; bottom:100px; left:50%; transform:translateX(-50%); background:${isError ? '#c0392b' : '#333'}; color:#fff; padding:10px 20px; border-radius:8px; z-index:10002; font-size:13px; box-shadow:0 4px 12px rgba(0,0,0,0.3); opacity:0; transition:0.3s; display:flex; align-items:center; gap:12px; white-space:nowrap;`;
      const textSpan = document.createElement("span");
      textSpan.textContent = msg;
      toast.appendChild(textSpan);
      if (withSettingsLink) {
        const link = document.createElement("button");
        link.textContent = "Open Settings";
        link.style.cssText = "background:rgba(255,255,255,0.2); border:none; border-radius:5px; color:#fff; font-size:12px; font-weight:700; padding:4px 10px; cursor:pointer; flex-shrink:0;";
        link.onclick = () => {
          toast.remove();
          document.querySelector("#qobuz-settings-panel")?.classList.add("open");
          // Also refresh key status display
          const key = getPaxKey();
          const status = document.querySelector("#qobuz-pax-key-status");
          if (status) {
            if (key) { status.className = "qobuz-api-key-status ok"; status.textContent = "✓ API key saved"; }
            else      { status.className = "qobuz-api-key-status missing"; status.textContent = "No API key saved. Streaming via Paxsenix will be unavailable."; }
          }
        };
        toast.appendChild(link);
      }
      document.body.appendChild(toast);
      requestAnimationFrame(() => toast.style.opacity = '1');
      setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, withSettingsLink ? 6000 : 3000);
    },

    start() { },
    stop() { this.close(); },
    destroy() {
      this.close();
      document.getElementById("qobuz-search-styles-v4")?.remove();
      document.getElementById("qobuz-search-panel")?.remove();
      document.getElementById("qobuz-search-overlay")?.remove();
      document.getElementById("qobuz-search-btn")?.remove();
      document.getElementById("qobuz-save-progress")?.remove();
    }
  };

  if (typeof Audion !== "undefined" && Audion.register) {
    Audion.register(QobuzSearch);
  } else {
    window.QobuzSearch = QobuzSearch;
    window.AudionPlugin = QobuzSearch;
  }
})();