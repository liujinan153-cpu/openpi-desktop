/* UI v3 设计稿交互（仅 mockup，接入时删除）
   - 主题切换（html[data-theme]）
   - chat.html：欢迎/对话态、dock 开关、todo 条开关、dock tab 切换
   - settings.html：左导航 tab 切换 */
(function () {
	// 支持 ?theme=light|dark 首帧指定主题（供截图/分享固定主题）
	try {
		var q = new URLSearchParams(location.search).get("theme");
		if (q === "light" || q === "dark") document.documentElement.dataset.theme = q;
	} catch (e) {}

	function refreshIcons() { try { window.lucide && window.lucide.createIcons(); } catch (e) {} }

	function toggleTheme() {
		var el = document.documentElement;
		el.dataset.theme = el.dataset.theme === "dark" ? "light" : "dark";
		refreshIcons();
	}

	// 主题按钮（class mock-theme 或 data-mock=theme）
	document.querySelectorAll("[class*=mock-theme], [data-mock=theme]").forEach(function (btn) {
		btn.addEventListener("click", toggleTheme);
	});

	// chat.html 视图切换
	var views = { welcome: document.getElementById("welcome"), convo: document.getElementById("convo") };
	// 对话态的 composer 示例内容在欢迎态下清空（真实应用中空会话输入框本来就是空的）
	var demoMemo = null;
	function setComposerDemo(show) {
		var input = document.getElementById("input");
		var imgBar = document.getElementById("img-bar");
		if (!input) return;
		if (!show && demoMemo === null) {
			demoMemo = { text: input.value, img: imgBar ? imgBar.hidden : false };
		}
		if (!show) { input.value = ""; if (imgBar) imgBar.hidden = true; }
		else if (demoMemo !== null) { input.value = demoMemo.text; if (imgBar) imgBar.hidden = demoMemo.img; }
	}
	document.querySelectorAll("[data-mock=welcome],[data-mock=convo]").forEach(function (btn) {
		btn.addEventListener("click", function () {
			var which = btn.dataset.mock === "welcome" ? "welcome" : "convo";
			Object.keys(views).forEach(function (k) {
				if (views[k]) views[k].hidden = k !== which;
			});
			setComposerDemo(which === "convo");
			document.querySelectorAll("[data-mock=welcome],[data-mock=convo]").forEach(function (b) {
				b.classList.toggle("on", b === btn);
			});
			refreshIcons();
		});
	});

	// dock 开关
	var dock = document.getElementById("dock");
	document.querySelectorAll("[data-mock=dock]").forEach(function (btn) {
		btn.addEventListener("click", function () {
			if (!dock) return;
			dock.hidden = !dock.hidden;
			btn.classList.toggle("on", !dock.hidden);
		});
	});

	// todo 条开关
	var todoBar = document.getElementById("todo-bar");
	document.querySelectorAll("[data-mock=todo]").forEach(function (btn) {
		btn.addEventListener("click", function () {
			if (!todoBar) return;
			todoBar.hidden = !todoBar.hidden;
			btn.classList.toggle("on", !todoBar.hidden);
		});
	});

	// dock tab 切换（pane 用 data-pane-body 对应）
	document.querySelectorAll(".dock-tab[data-pane]").forEach(function (tab) {
		tab.addEventListener("click", function () {
			document.querySelectorAll(".dock-tab[data-pane]").forEach(function (t) { t.classList.toggle("on", t === tab); });
			document.querySelectorAll("[data-pane-body]").forEach(function (p) {
				p.hidden = p.dataset.paneBody !== tab.dataset.pane;
			});
		});
	});

	// steps-group 折叠
	document.querySelectorAll(".steps-group .sg-summary").forEach(function (s) {
		s.addEventListener("click", function () { s.parentElement.classList.toggle("open"); });
	});

	// settings.html 左导航切换
	document.querySelectorAll(".settings-nav .tab[data-tab]").forEach(function (tab) {
		tab.addEventListener("click", function () {
			document.querySelectorAll(".settings-nav .tab[data-tab]").forEach(function (t) { t.classList.toggle("active", t === tab); });
			document.querySelectorAll(".tab-pane").forEach(function (p) {
				p.classList.toggle("hidden", p.id !== "tab-" + tab.dataset.tab);
			});
			refreshIcons();
		});
	});

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refreshIcons);
	else refreshIcons();
})();
