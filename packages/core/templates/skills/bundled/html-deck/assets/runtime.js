/* html-deck :: runtime.js — 键盘驱动的演示运行时
 *
 * 功能清单：
 *   ← → ↑ ↓ / Space / Enter / PgUp PgDn / Home End  导航
 *   F   全屏切换（退出总览模式）
 *   T   循环切换主题（读取 body/html 的 data-themes 属性）
 *   O   总览模式（缩略图网格，点击跳转）
 *   N   演讲者备注抽屉显示/隐藏
 *   ESC 退出全屏 / 退出总览模式
 *   URL hash #/N  深链接到第 N 页（1-based）
 *   进度条与页码自动管理
 *
 * 零依赖，不使用 eval/Function 构造器，CSP 友好。
 */

(function () {
  "use strict";

  /** DOM 就绪后执行回调 */
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    /** @type {HTMLElement} deck 容器 */
    var deck = document.querySelector(".deck");
    if (!deck) return;

    /** @type {HTMLElement[]} 所有幻灯片 */
    var slides = Array.prototype.slice.call(deck.querySelectorAll(".slide"));
    var total = slides.length;
    if (total === 0) return;

    /** 当前幻灯片索引（0-based） */
    var idx = 0;

    /* ===== 创建进度条 ===== */
    var progressBar = document.createElement("div");
    progressBar.className = "progress-bar";
    progressBar.style.width = "0%";
    document.body.appendChild(progressBar);

    /* ===== 初始化每页的动画类 =====
     * 读取 data-anim 属性，为带动画的元素添加对应 class
     * 仅在 .is-active 时播放，避免所有页同时动画
     */
    slides.forEach(function (slide) {
      var anim = slide.getAttribute("data-anim");
      if (anim) {
        // 为 slide 本身添加 anim- 前缀类
        slide.classList.add("anim-" + anim);
      }
    });

    /**
     * 切换到指定索引的幻灯片
     * @param {number} i 目标索引（0-based）
     * @param {boolean} updateHash 是否更新 URL hash
     */
    function go(i, updateHash) {
      if (i < 0) i = 0;
      if (i >= total) i = total - 1;
      if (i === idx && slides[idx].classList.contains("is-active")) return;

      // 移除旧页状态
      slides.forEach(function (s, j) {
        s.classList.remove("is-active", "is-prev");
      });

      // 设置新页状态
      slides[i].classList.add("is-active");
      if (i > 0) slides[i - 1].classList.add("is-prev");

      idx = i;

      // 更新进度条
      var pct = total > 1 ? (i / (total - 1)) * 100 : 100;
      progressBar.style.width = pct + "%";

      // 更新页码显示
      var numbers = slides[i].querySelectorAll(".slide-number");
      numbers.forEach(function (n) {
        n.setAttribute("data-current", String(i + 1));
        n.setAttribute("data-total", String(total));
        n.textContent = i + 1 + " / " + total;
      });

      // 更新 URL hash（用于深链接分享）
      if (updateHash !== false) {
        history.replaceState(null, "", "#/" + (i + 1));
      }

      // 重置当前页动画：移除并重新触发
      var anim = slides[i].getAttribute("data-anim");
      if (anim) {
        var cls = "anim-" + anim;
        slides[i].classList.remove(cls);
        // 强制重排以重启动画
        void slides[i].offsetWidth;
        slides[i].classList.add(cls);
      }
    }

    /** 跳到下一页 */
    function next() {
      go(idx + 1);
    }
    /** 跳到上一页 */
    function prev() {
      go(idx - 1);
    }

    /* ===== 从 URL hash 读取初始页 =====
     * 支持 #/N 格式（1-based），如 #/3 跳到第 3 页
     */
    function readHash() {
      var m = /^#\/(\d+)$/.exec(location.hash || "");
      if (m) {
        var n = parseInt(m[1], 10) - 1;
        if (n >= 0 && n < total) return n;
      }
      return 0;
    }

    /* ===== 总览模式 ===== */
    var overviewActive = false;

    /** 切换总览模式 */
    function toggleOverview() {
      overviewActive = !overviewActive;
      document.documentElement.classList.toggle("overview", overviewActive);
      if (!overviewActive) {
        // 退出总览时回到当前页
        go(idx, false);
      }
    }

    /* ===== 全屏切换 ===== */
    function toggleFullscreen() {
      if (!document.fullscreenElement) {
        var el = document.documentElement;
        var req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
        if (req) req.call(el);
      } else {
        var exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
        if (exit) exit.call(document);
      }
    }

    /* ===== 主题循环 =====
     * 读取 body 或 html 的 data-themes 属性（逗号分隔）
     * 切换 <link id="theme-link"> 的 href
     */
    var themeIdx = 0;
    function cycleTheme() {
      var themesAttr =
        document.body.getAttribute("data-themes") || document.documentElement.getAttribute("data-themes");
      if (!themesAttr) return;

      var themes = themesAttr
        .split(",")
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
      if (themes.length < 2) return;

      themeIdx = (themeIdx + 1) % themes.length;
      var nextTheme = themes[themeIdx];

      var link = document.getElementById("theme-link");
      if (link) {
        // 从 data-theme-base 读取主题目录，无则用当前 href 所在目录
        var base =
          document.documentElement.getAttribute("data-theme-base") || document.body.getAttribute("data-theme-base");
        if (!base) {
          var raw = link.getAttribute("href") || "";
          var ls = raw.lastIndexOf("/");
          base = ls >= 0 ? raw.substring(0, ls + 1) : "./_shared/themes/";
        }
        link.href = base + nextTheme + ".css";
        document.documentElement.setAttribute("data-theme", nextTheme);
      }
    }

    /* ===== 演讲者备注抽屉 ===== */
    var notesOverlay = null;
    function toggleNotes() {
      if (!notesOverlay) {
        // 创建全局备注抽屉，内容取自当前页 .notes
        notesOverlay = document.createElement("div");
        notesOverlay.className = "notes";
        notesOverlay.setAttribute("role", "status");
        notesOverlay.setAttribute("aria-live", "polite");
        document.body.appendChild(notesOverlay);
      }
      var visible = notesOverlay.classList.toggle("visible");
      if (visible) {
        // 显示当前页的备注内容
        var note = slides[idx].querySelector(".notes");
        notesOverlay.innerHTML = note ? note.innerHTML : "<em>本页无备注</em>";
      }
    }

    /* ===== 键盘事件处理 ===== */
    document.addEventListener("keydown", function (e) {
      // 在可编辑元素内输入时不拦截按键
      var tag = (e.target && e.target.tagName) || "";
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;

      // 总览模式下，任意导航键退出总览
      if (overviewActive) {
        if (e.key === "Escape" || e.key === "o" || e.key === "O") {
          e.preventDefault();
          toggleOverview();
          return;
        }
        // 数字键直接跳转
        if (e.key >= "1" && e.key <= "9") {
          var n = parseInt(e.key, 10) - 1;
          if (n < total) {
            e.preventDefault();
            toggleOverview();
            go(n);
          }
          return;
        }
        return; // 总览模式不处理其他键
      }

      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case " ":
        case "PageDown":
        case "Enter":
          e.preventDefault();
          next();
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          prev();
          break;
        case "Home":
          e.preventDefault();
          go(0);
          break;
        case "End":
          e.preventDefault();
          go(total - 1);
          break;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "t":
        case "T":
          e.preventDefault();
          cycleTheme();
          break;
        case "o":
        case "O":
          e.preventDefault();
          toggleOverview();
          break;
        case "n":
        case "N":
          e.preventDefault();
          toggleNotes();
          break;
        case "Escape":
          if (document.fullscreenElement) {
            e.preventDefault();
            var exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
            if (exit) exit.call(document);
          }
          break;
        default:
          // 数字键 1-9 直接跳转
          if (e.key >= "1" && e.key <= "9" && !e.ctrlKey && !e.metaKey) {
            var num = parseInt(e.key, 10) - 1;
            if (num < total) {
              e.preventDefault();
              go(num);
            }
          }
      }
    });

    /* ===== 总览模式点击跳转 ===== */
    deck.addEventListener("click", function (e) {
      if (!overviewActive) return;
      var target = e.target;
      while (target && target !== deck) {
        if (target.classList && target.classList.contains("slide")) {
          var i = slides.indexOf(target);
          if (i >= 0) {
            toggleOverview();
            go(i);
          }
          return;
        }
        target = target.parentNode;
      }
    });

    /* ===== 鼠标滚轮翻页（非总览模式） =====
     * 节流处理，避免连续触发
     */
    var wheelLock = false;
    document.addEventListener(
      "wheel",
      function (e) {
        if (overviewActive) return;
        var delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (Math.abs(delta) < 30) return;
        if (wheelLock) return;
        wheelLock = true;
        setTimeout(function () {
          wheelLock = false;
        }, 600);
        if (delta > 0) next();
        else prev();
      },
      { passive: true }
    );

    /* ===== hash 变化时跳转 ===== */
    window.addEventListener("hashchange", function () {
      var n = readHash();
      if (n !== idx) go(n, false);
    });

    /* ===== 初始化：跳到 hash 指定页 ===== */
    var startIdx = readHash();
    go(startIdx, false);

    // 暴露 API 供外部调用（如演示者窗口）
    window.__deck = {
      go: go,
      next: next,
      prev: prev,
      total: total,
      current: function () {
        return idx;
      },
    };
  });
})();
