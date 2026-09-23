/* UI v3.1：select 皮肤（自绘弹层）
   原生 <select> 的下拉弹层由操作系统渲染，无法跟随主题（暗色下白底蓝条）。
   本组件把目标 select 隐藏，代理为一个同款按钮 + 自绘弹层；
   原生元素与 change 事件全保留：app 逻辑与 e2e 的 .value= / dispatchEvent 照常工作，
   并通过 value setter 补丁 + change 监听让按钮文案始终同步。
   范围：composer chips（审批/接力/思考/模型）、dock 预览尺寸、设置弹窗内 select.input */
(function () {
	const SELECTOR = "select.chip-select, #pv-size, #settings select.input";

	const label = (sel) => (sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : "");

	function closeAll() {
		document.querySelectorAll(".uisel-pop").forEach((p) => p.remove());
	}

	function optHtml(o) {
		return `<div class="uisel-opt${o.selected ? " on" : ""}" data-v="${String(o.value).replace(/"/g, "&quot;")}">${o.textContent}</div>`;
	}

	function open(sel, anchor) {
		closeAll();
		const rect = (anchor || sel).getBoundingClientRect(); /* 锚点=代理按钮（原生 select 已隐藏，rect 为 0） */
		const pop = document.createElement("div");
		pop.className = "uisel-pop";
		let html = "";
		for (const n of sel.children) {
			if (n.tagName === "OPTGROUP") {
				html += `<div class="uisel-group">${n.label}</div>`;
				for (const o of n.children) html += optHtml(o);
			} else if (n.tagName === "OPTION") {
				html += optHtml(n);
			}
		}
		pop.innerHTML = html;
		document.body.appendChild(pop);
		pop.style.minWidth = Math.max(rect.width, 160) + "px";
		pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12)) + "px";
		let top = rect.bottom + 6;
		if (top + pop.offsetHeight > window.innerHeight - 12) top = Math.max(8, rect.top - pop.offsetHeight - 6);
		pop.style.top = top + "px";
		pop.addEventListener("click", (e) => {
			const opt = e.target.closest(".uisel-opt");
			if (!opt) return;
			if (sel.value !== opt.dataset.v) {
				sel.value = opt.dataset.v;
				sel.dispatchEvent(new Event("change", { bubbles: true }));
			}
			closeAll();
		});
		pop.addEventListener("mouseover", (e) => {
			const opt = e.target.closest(".uisel-opt");
			if (!opt) return;
			pop.querySelectorAll(".uisel-opt.on").forEach((x) => x.classList.remove("on"));
			opt.classList.add("on");
		});
	}

	function enhance(sel) {
		if (sel.dataset.uisel === "1") return;
		sel.dataset.uisel = "1";
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = sel.className + " uisel-btn";
		btn.title = sel.title;
		btn.textContent = label(sel);
		sel.before(btn);
		sel.classList.add("uisel-src"); /* 必须在复制 className 之后，否则按钮连带隐藏 */
		const sync = () => { btn.textContent = label(sel); };
		sel.addEventListener("change", sync);
		// 拦截 .value= 赋值（e2e / app 内部编程式设置）让按钮文案即时同步
		try {
			const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
			Object.defineProperty(sel, "value", {
				get() { return desc.get.call(this); },
				set(v) { desc.set.call(this, v); queueMicrotask(sync); },
			});
		} catch {}
		// options 动态重建（模型列表/字体列表异步填充）时同步文案
		new MutationObserver(sync).observe(sel, { childList: true, subtree: true });
		btn.addEventListener("click", () => {
			if (document.querySelector(".uisel-pop")) { closeAll(); return; }
			open(sel, btn);
		});
	}

	function init() {
		document.querySelectorAll(SELECTOR).forEach(enhance);
	}

	document.addEventListener("mousedown", (e) => {
		if (!e.target.closest(".uisel-pop") && !e.target.closest(".uisel-btn")) closeAll();
	});
	document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
	window.addEventListener("blur", closeAll);

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
	window.OpenPiSelect = { enhance, init };
})();
