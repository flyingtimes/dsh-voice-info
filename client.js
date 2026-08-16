/**
 * dsh-voice-info — 客户端（Web GUI）。
 *
 * 两个表面：
 *   - 侧栏底部一个喇叭入口（sidebar.footer.action）：状态点
 *     绿=就绪 / 灰=静音时段 / 红=上次失败 / 黄=播报中，点击开关设置面板
 *   - 固定定位的设置面板：开关/模式/音量/静音时段/冷却等，
 *     通过 POST /plugin-api/voice-info/config 实时写回（免重启），
 *     试听按钮走 /plugin-api/voice-info/test?announce=1
 *
 * 纯 React 薄壳 + fetch；不依赖其他客户端包。
 */
window.__ModuleLoader__.load({
  id: "dsh-voice-info",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var jsx = require("react/jsx-runtime");

    var CSS = [
      ".vi-launch{width:100%;height:49px;color:var(--dsw-alias-label-primary);cursor:pointer;background:transparent;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 8px 0 6px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}",
      ".vi-launch:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
      ".vi-launch[data-active]{background:var(--dsw-alias-interactive-bg-hover)}",
      ".vi-launch .vi-horn{flex:none;font-size:15px}",
      ".vi-dot{width:8px;height:8px;border-radius:50%;flex:none;margin-left:auto;background:#3fb950;box-shadow:0 0 0 3px rgba(63,185,80,.15)}",
      ".vi-dot.vi-dot--quiet{background:#8b949e;box-shadow:0 0 0 3px rgba(139,148,158,.15)}",
      ".vi-dot.vi-dot--error{background:#f85149;box-shadow:0 0 0 3px rgba(248,81,73,.18)}",
      ".vi-dot.vi-dot--busy{background:#d29922;box-shadow:0 0 0 3px rgba(210,153,34,.2);animation:vi-pulse 1s infinite alternate}",
      "@keyframes vi-pulse{from{opacity:.45}to{opacity:1}}",
      ".vi-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
      ".vi-panel{position:fixed;left:12px;bottom:60px;z-index:9500;width:308px;max-height:min(72vh,560px);overflow:auto;background:var(--dsw-alias-surface-1,#161a22);color:var(--dsw-alias-label-primary,#e8e8f0);border:1px solid var(--dsw-alias-border-subtle,#2a2f3a);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.45);padding:14px;font-size:13px}",
      ".vi-panel-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}",
      ".vi-panel-title{font-weight:700;font-size:14px}",
      ".vi-panel-close{margin-left:auto;width:26px;height:26px;border-radius:8px;border:1px solid var(--dsw-alias-border-subtle,#2a2f3a);background:transparent;color:inherit;cursor:pointer;line-height:1;font-size:13px}",
      ".vi-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
      ".vi-row{display:flex;align-items:center;gap:8px;margin:9px 0}",
      ".vi-row label:first-child{flex:none;width:88px;color:var(--dsw-alias-label-secondary,#b6bfd0)}",
      ".vi-row input[type=range]{flex:1;accent-color:var(--dsw-alias-accent,#4fd8ff)}",
      ".vi-row input[type=time],.vi-row input[type=number],.vi-row select{flex:1;min-width:0;background:var(--dsw-alias-surface-2,#1d232e);color:inherit;border:1px solid var(--dsw-alias-border-subtle,#2a2f3a);border-radius:8px;padding:4px 8px;font-family:inherit;font-size:13px}",
      ".vi-status{margin:4px 0 10px;padding:7px 10px;border-radius:9px;background:var(--dsw-alias-surface-2,#1d232e);color:var(--dsw-alias-label-secondary,#b6bfd0);font-size:12px;line-height:1.6}",
      ".vi-status b{color:var(--dsw-alias-label-primary,#e8e8f0)}",
      ".vi-actions{display:flex;gap:8px;margin-top:12px}",
      ".vi-btn{flex:1;border-radius:9px;border:1px solid var(--dsw-alias-border-subtle,#2a2f3a);background:var(--dsw-alias-surface-2,#1d232e);color:inherit;cursor:pointer;padding:7px 0;font-family:inherit;font-size:13px}",
      ".vi-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
      ".vi-btn.vi-btn--primary{background:var(--dsw-alias-accent,#4fd8ff);border-color:transparent;color:#04222c;font-weight:700}",
      ".vi-btn.vi-btn--primary:hover{filter:brightness(1.08)}",
      ".vi-note{margin-top:9px;color:var(--dsw-alias-label-tertiary,#8a93a6);font-size:11.5px;line-height:1.55}",
      ".vi-saved{color:#3fb950;font-size:12px}",
      ".vi-err{color:#f85149;font-size:12px}",
    ].join("\n");
    try {
      var styleEl = document.createElement("style");
      styleEl.setAttribute("data-plugin", "dsh-voice-info");
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
    } catch (e) { /* SSR/测试环境 */ }

    // ---- 开关状态存储（同 raiden 的 gameStore 模式） ----
    var listeners = new Set();
    var openState = false;
    var panelStore = {
      getSnapshot: function () { return openState; },
      subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
      open: function () { openState = true; listeners.forEach(function (fn) { fn(); }); },
      close: function () { openState = false; listeners.forEach(function (fn) { fn(); }); },
      toggle: function () { panelStore[openState ? "close" : "open"](); }
    };

    var CONFIG_URL = "/plugin-api/voice-info/config";
    var TEST_URL = "/plugin-api/voice-info/test?announce=1";

    function fetchJson(url, opts) {
      return fetch(url, opts).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: "bad json" }; });
      });
    }

    function dotClass(st) {
      if (!st) return "";
      if (st.busy) return "vi-dot vi-dot--busy";
      if (st.quietHoursActive) return "vi-dot vi-dot--quiet";
      if (st.lastOutcome === "error") return "vi-dot vi-dot--error";
      return "vi-dot";
    }

    function VoiceLauncher() {
      var open = React.useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot);
      var statusRef = React.useRef(null);
      var force = React.useReducer(function (c) { return c + 1; }, 0)[1];
      React.useEffect(function () {
        var alive = true;
        var poll = function () {
          fetchJson(CONFIG_URL).then(function (j) {
            if (!alive) return;
            statusRef.current = j && j.ok ? j.state : null;
            force();
          }).catch(function () {});
        };
        poll();
        var t = setInterval(poll, 8000);
        return function () { alive = false; clearInterval(t); };
      }, []);
      return jsx.jsxs("button", {
        className: "vi-launch",
        "data-active": open || undefined,
        onClick: panelStore.toggle,
        title: "语音播报设置",
        children: [
          jsx.jsx("span", { className: "vi-horn", key: "horn", children: "🔊" }),
          jsx.jsx("span", { className: "vi-label", key: "label", children: "语音播报" }),
          jsx.jsx("span", { className: dotClass(statusRef.current), key: "dot" })
        ]
      });
    }

    function VoicePanel() {
      var open = React.useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot);
      if (!open) return null;
      return jsx.jsx(VoicePanelBody, {});
    }

    function VoicePanelBody() {
      var cfgRef = React.useRef(null);
      var stateRef = React.useRef(null);
      var force = React.useReducer(function (c) { return c + 1; }, 0)[1];
      var formRef = React.useRef({});
      var msgRef = React.useRef(null);

      var load = function () {
        fetchJson(CONFIG_URL).then(function (j) {
          if (j && j.ok) {
            cfgRef.current = j.config;
            stateRef.current = j.state;
            formRef.current = {
              enabled: j.config.enabled,
              detail: j.config.detail,
              volume: j.config.volume,
              quietStart: (j.config.quietHours && j.config.quietHours[0]) || "",
              quietEnd: (j.config.quietHours && j.config.quietHours[1]) || "",
              cooldownSec: Math.round((j.config.cooldownMs || 0) / 1000),
              minDurationSec: Math.round((j.config.minDurationMs || 0) / 1000),
              blockedQuietPolicy: j.config.blockedQuietPolicy,
              overnightDigest: j.config.overnightDigest
            };
          } else {
            msgRef.current = { kind: "err", text: (j && j.error) || "配置读取失败" };
          }
          force();
        }).catch(function (e) {
          msgRef.current = { kind: "err", text: "无法连接插件服务" };
          force();
        });
      };

      React.useEffect(function () {
        load();
        var t = setInterval(load, 5000);
        return function () { clearInterval(t); };
      }, []);

      var f = formRef.current;
      var st = stateRef.current;
      var set = function (k, v) { formRef.current[k] = v; force(); };

      var doTest = function () {
        msgRef.current = { kind: "ok", text: "已触发试听（绕过静音/冷却）" };
        force();
        fetchJson(TEST_URL, { method: "POST" }).catch(function () {});
      };

      var doSave = function () {
        var qh = [];
        if (f.quietStart && f.quietEnd) qh = [f.quietStart, f.quietEnd];
        var body = {
          enabled: !!f.enabled,
          detail: f.detail,
          volume: Number(f.volume),
          quietHours: qh,
          cooldownMs: Math.max(0, Math.round(Number(f.cooldownSec || 0) * 1000)),
          minDurationMs: Math.max(0, Math.round(Number(f.minDurationSec || 0) * 1000)),
          blockedQuietPolicy: f.blockedQuietPolicy,
          overnightDigest: !!f.overnightDigest
        };
        fetchJson(CONFIG_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }).then(function (j) {
          if (j && j.ok) {
            var restart = j.restartRequired && j.restartRequired.length;
            msgRef.current = {
              kind: "ok",
              text: restart
                ? "已保存；keepAlive 相关改动需重启 dsh web 生效"
                : "已保存并即时生效"
            };
          } else {
            msgRef.current = { kind: "err", text: "保存失败: " + ((j && j.error) || "未知错误") };
          }
          load();
        }).catch(function () {
          msgRef.current = { kind: "err", text: "保存请求失败" };
          force();
        });
      };

      if (!f || f.detail === undefined) {
        return jsx.jsx("div", { className: "vi-panel", children: "加载配置中…" });
      }

      var lastLine = st
        ? (st.lastOutcome
          ? "上次播报(" + (st.lastOutcome === "ok" ? "成功" : "失败") + "): " + String(st.lastText || "-").slice(0, 24)
          : "尚无播报记录")
        : "状态未知";

      return jsx.jsxs("div", { className: "vi-panel", children: [
        jsx.jsxs("div", { className: "vi-panel-head", children: [
          jsx.jsx("span", { className: "vi-panel-title", children: "🔊 语音播报" }),
          jsx.jsx("button", { className: "vi-panel-close", onClick: panelStore.close, children: "✕" })
        ] }),
        jsx.jsxs("div", { className: "vi-status", children: [
          jsx.jsx("b", { children: st && st.busy ? "播报中…" : "空闲" }),
          st && st.quietHoursActive ? " · 静音时段" : "",
          " · 待播摘要 " + (st ? st.digestQueue : 0) + " 条",
          jsx.jsx("br", {}),
          lastLine
        ] }),
        jsx.jsxs("div", { className: "vi-row", children: [
          jsx.jsx("label", { children: "启用" }),
          jsx.jsx("input", {
            type: "checkbox",
            checked: !!f.enabled,
            onChange: function (e) { set("enabled", e.target.checked); }
          })
        ] }),
        jsx.jsxs("div", { className: "vi-row", children: [
          jsx.jsx("label", { children: "播报模式" }),
          jsx.jsxs("select", {
            value: f.detail,
            onChange: function (e) { set("detail", e.target.value); },
            children: [
              jsx.jsx("option", { value: "fixed", children: "固定一句话" }),
              jsx.jsx("option", { value: "template", children: "原因+时长" }),
              jsx.jsx("option", { value: "excerpt", children: "结果摘录" }),
              jsx.jsx("option", { value: "llm", children: "LLM 摘要" })
            ]
          })
        ] }),
        jsx.jsxs("div", { className: "vi-row", children: [
          jsx.jsx("label", { children: "音量 " + Math.round(f.volume * 100) + "%" }),
          jsx.jsx("input", {
            type: "range", min: "0", max: "1", step: "0.05",
            value: f.volume,
            onChange: function (e) { set("volume", Number(e.target.value)); }
          })
        ] }),
        jsx.jsxs("div", { className: "vi-row", children: [
          jsx.jsx("label", { children: "静音时段" }),
          jsx.jsx("input", {
            type: "time", value: f.quietStart,
            onChange: function (e) { set("quietStart", e.target.value); }
          }),
          jsx.jsx("span", { children: "至" }),
          jsx.jsx("input", {
            type: "time", value: f.quietEnd,
            onChange: function (e) { set("quietEnd", e.target.value); }
          })
        ] }),
        jsx.jsxs("div", { className: "vi-row", children: [
          jsx.jsx("label", { children: "冷却(秒)" }),
          jsx.jsx("input", {
            type: "number", min: "0", max: "3600", value: f.cooldownSec,
            onChange: function (e) { set("cooldownSec", Number(e.target.value)); }
          })
        ] }),
        jsx.jsxs("div", { className: "vi-row", children: [
          jsx.jsx("label", { title: "轮次运行时长低于该值不播报", children: "最短轮(秒)" }),
          jsx.jsx("input", {
            type: "number", min: "0", max: "3600", value: f.minDurationSec,
            onChange: function (e) { set("minDurationSec", Number(e.target.value)); }
          })
        ] }),
        jsx.jsxs("div", { className: "vi-row", children: [
          jsx.jsx("label", { title: "agent 等确认的阻塞提醒在静音时段的行为", children: "阻塞提醒" }),
          jsx.jsxs("select", {
            value: f.blockedQuietPolicy,
            onChange: function (e) { set("blockedQuietPolicy", e.target.value); },
            children: [
              jsx.jsx("option", { value: "local", children: "静音时走本机" }),
              jsx.jsx("option", { value: "speaker", children: "静音也照播音箱" }),
              jsx.jsx("option", { value: "skip", children: "静音时跳过" })
            ]
          })
        ] }),
        jsx.jsxs("div", { className: "vi-row", children: [
          jsx.jsx("label", { title: "静音时段的播报存入队列，早上汇总一次", children: "过夜摘要" }),
          jsx.jsx("input", {
            type: "checkbox",
            checked: !!f.overnightDigest,
            onChange: function (e) { set("overnightDigest", e.target.checked); }
          })
        ] }),
        jsx.jsxs("div", { className: "vi-actions", children: [
          jsx.jsx("button", { className: "vi-btn", onClick: doTest, children: "🔈 试听" }),
          jsx.jsx("button", { className: "vi-btn vi-btn--primary", onClick: doSave, children: "保存" })
        ] }),
        msgRef.current
          ? jsx.jsx("div", { className: msgRef.current.kind === "ok" ? "vi-saved" : "vi-err", children: msgRef.current.text })
          : null,
        jsx.jsx("div", { className: "vi-note", children: "保存即时生效（无需重启）；keepAlive 与日志路径仍需改配置文件并重启。完整字段见 config.json。" })
      ] });
    }

    var inject = ["slots"];
    function apply(ctx) {
      ctx.effect(function () {
        var disposers = [
          ctx.slots.inject("sidebar.footer.action", function () {
            return ctx.slots.register({
              name: "sidebar.footer.action",
              id: "voice-info-launch",
              order: 20,
              inject: function () { return {}; }
            }, VoiceLauncher);
          }),
          ctx.slots.inject("shell.overlay", function () {
            return ctx.slots.register({
              name: "shell.overlay",
              id: "voice-info-panel",
              order: 20,
              inject: function () { return {}; }
            }, VoicePanel);
          })
        ];
        return function () { for (var i = 0; i < disposers.length; i++) disposers[i](); };
      }, "voice-info: launcher + panel");
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.store = panelStore;
    return module.exports;
  }
});
