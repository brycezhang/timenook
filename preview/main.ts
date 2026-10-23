import "./base.css";
import { read as readProject } from "../miniprogram/services/store";
import { dataMode, livePageAllowed } from "../miniprogram/services/mode";
import {
  createRecorder,
  createAudio,
  temporaryFile,
  saveBlob,
  writeBlob,
  resolveBlob,
} from "./media";
const root = document.querySelector<HTMLElement>("#page")!,
  phone = document.querySelector<HTMLElement>("#phone")!,
  overlay = document.querySelector<HTMLElement>("#overlay")!;
const imports = import.meta.glob("../miniprogram/pages/*/index.ts");
const templates = import.meta.glob("../miniprogram/pages/*/index.wxml", {
  query: "?raw",
  import: "default",
  eager: true,
});
const styles = import.meta.glob("../miniprogram/**/*.wxss", {
  query: "?raw",
  import: "default",
  eager: true,
});
const configs = import.meta.glob("../miniprogram/pages/*/index.json", {
  eager: true,
  import: "default",
});
const names = Object.keys(imports).map((k) => k.split("/")[3]);
let current: any = null,
  route = "",
  template: Element | null = null,
  serial = 0,
  scheduled = false;
const definitions: Record<string, any> = {};
let registering = "";
let cssTag = document.createElement("style");
document.head.append(cssTag);
function css(source: string) {
  return source
    .replace(/@import[^;]+;/g, "")
    .replace(/(^|[},\s])page(?=[\s{,:])/g, "$1#page")
    .replace(/\bview(?=[\s:.#>+\[{,])/g, "div")
    .replace(/\btext(?=[\s:.#>+\[{,])/g, "span")
    .replace(/\bimage(?=[\s:.#>+\[{,])/g, "img")
    .replace(
      /(-?[\d.]+)rpx/g,
      (_, n) => `${(Number(n) * phone.clientWidth) / 750}px`,
    )
    .replace(/100vh/g, "var(--phone-height)");
}
function updateStyles() {
  phone.style.setProperty("--phone-height", phone.clientHeight + "px");
  cssTag.textContent = css(
    String(styles["../miniprogram/styles/tokens.wxss"]) +
      String(styles["../miniprogram/app.wxss"]) +
      String(styles[`../miniprogram/pages/${route}/index.wxss`] || ""),
  );
}
new ResizeObserver(updateStyles).observe(phone);
function toast(message: string) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  phone.append(node);
  setTimeout(() => node.remove(), 2800);
}
function modal(options: any) {
  overlay.replaceChildren();
  const box = document.createElement("div");
  box.className = "modal";
  const title = document.createElement("h2"),
    content = document.createElement("p"),
    actions = document.createElement("div");
  title.textContent = options.title;
  content.textContent = options.content;
  actions.className = "modal-actions";
  if (options.showCancel !== false) {
    const cancel = document.createElement("button");
    cancel.textContent = options.cancelText || "取消";
    cancel.onclick = () => {
      overlay.replaceChildren();
      options.success?.({ confirm: false, cancel: true });
    };
    actions.append(cancel);
  }
  const ok = document.createElement("button");
  ok.textContent = options.confirmText || "知道了";
  ok.onclick = () => {
    overlay.replaceChildren();
    options.success?.({ confirm: true, cancel: false });
  };
  actions.append(ok);
  box.append(title, content, actions);
  overlay.append(box);
}
function targetUrl(url: string) {
  return "#/" + url.replace(/^\/pages\//, "").replace("/index", "");
}
const recorder = createRecorder();
const wx: any = {
  getStorageSync(key: string) {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : undefined;
  },
  setStorageSync(key: string, v: unknown) {
    localStorage.setItem(key, JSON.stringify(v));
  },
  removeStorageSync(key: string) {
    localStorage.removeItem(key);
  },
  request(options: any) {
    // Browser preview uses the same authenticated order boundary; it cannot synthesize wx.login or native payment.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeout ?? 10000,
    );
    const url = new URL(options.url, location.origin);
    const supported =
      ((!options.method || options.method === "GET") &&
        /\/v1\/(recipient-types|packages\/current|orders(?:\/[a-f0-9-]{36})?|participations|invitations\/[A-Za-z0-9_-]{43}|projects\/[a-f0-9-]{36}\/(?:participation|binding-requests|care-requests|assisted-sessions))$/.test(
          url.pathname,
        )) ||
      (options.method === "POST" &&
        /\/v1\/(?:orders(?:\/[a-f0-9-]{36}\/(?:payment|close))?|projects\/[a-f0-9-]{36}\/(?:invitations|consents(?:\/revoke)?|care-requests|assisted-sessions)|invitations\/[A-Za-z0-9_-]{43}\/requests|binding-requests\/[a-f0-9-]{36}\/approve)$/.test(
          url.pathname,
        ));
    void (async () => {
      try {
        if (!supported) throw new Error("Unsupported preview request");
        const response = await fetch(url, {
          method: options.method ?? "GET",
          headers: options.header,
          body:
            options.method === "POST"
              ? JSON.stringify(options.data ?? {})
              : undefined,
          credentials: "omit",
          signal: controller.signal,
        });
        const result = {
          statusCode: response.status,
          data: await response.json(),
          header: Object.fromEntries(response.headers.entries()),
          cookies: [],
          errMsg: "request:ok",
        };
        options.success?.(result);
        options.complete?.(result);
      } catch {
        const result = { errMsg: "request:fail" };
        options.fail?.(result);
        options.complete?.(result);
      } finally {
        clearTimeout(timer);
      }
    })();
    return {
      abort() {
        controller.abort();
      },
    };
  },
  navigateTo({ url }: any) {
    location.hash = targetUrl(url);
  },
  reLaunch({ url }: any) {
    history.replaceState(null, "", targetUrl(url));
    void mount();
  },
  navigateBack() {
    if (history.length > 1) history.back();
    else wx.reLaunch({ url: "/pages/project/index" });
  },
  showToast({ title }: any) {
    toast(title);
  },
  showModal: modal,
  setNavigationBarTitle({ title }: any) {
    document.querySelector("#nav-title")!.textContent = title;
  },
  getRecorderManager() {
    return recorder;
  },
  createInnerAudioContext: createAudio,
  env: { USER_DATA_PATH: "local-data:" },
  openSetting() {
    modal({
      title: "麦克风权限",
      content:
        "请在浏览器地址栏的站点权限中允许麦克风，然后返回重试。微信真机上会打开小程序权限设置。",
      showCancel: false,
    });
  },
  getFileSystemManager() {
    return {
      saveFile(o: any) {
        saveBlob(o.tempFilePath)
          .then((savedFilePath) => o.success?.({ savedFilePath }))
          .catch((e) => o.fail?.(e));
      },
      writeFile(o: any) {
        writeBlob(o.filePath, new Blob([o.data], { type: "application/json" }))
          .then(() => o.success?.())
          .catch((e) => o.fail?.(e));
      },
    };
  },
  chooseMedia(o: any) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = o.count > 1;
    input.onchange = () => {
      const files = Array.from(input.files || []).slice(0, o.count);
      if (files.length)
        o.success?.({
          tempFiles: files.map((file) => ({
            tempFilePath: temporaryFile(file),
          })),
        });
    };
    input.click();
  },
  async shareFileMessage(o: any) {
    try {
      const url = await resolveBlob(o.filePath);
      const link = document.createElement("a");
      link.href = url;
      const mediaType = (await fetch(url)).headers.get("content-type") || "";
      link.download = o.fileName?.endsWith(".mp3")
        ? o.fileName.replace(
            ".mp3",
            mediaType.includes("mp4") ? ".m4a" : ".webm",
          )
        : o.fileName || "时光里-资料.json";
      link.click();
      o.success?.();
    } catch (e) {
      o.fail?.(e);
    }
  },
};
Object.assign(window, {
  wx,
  Page: (def: any) => {
    definitions[registering] = def;
  },
  App: () => {},
});
function evaluate(expression: string, scope: any) {
  return Function("scope", `with(scope){return (${expression})}`)(scope);
}
function interpolate(source: string, scope: any) {
  return source.replace(/{{([\s\S]*?)}}/g, (_, expr) => {
    const value = evaluate(expr, scope);
    return value == null ? "" : String(value);
  });
}
function value(source: string, scope: any) {
  const match = source.match(/^{{([\s\S]*)}}$/);
  return match ? evaluate(match[1], scope) : source;
}
function renderChildren(node: Node, scope: any, parent: Node) {
  let conditional: boolean | null = null;
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      parent.appendChild(
        document.createTextNode(interpolate(child.textContent || "", scope)),
      );
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (el.hasAttribute("wx:if")) {
      conditional = !!value(el.getAttribute("wx:if")!, scope);
      if (!conditional) continue;
    } else if (el.hasAttribute("wx:else")) {
      if (conditional !== false) continue;
      conditional = null;
    } else if (el.hasAttribute("wx:elif")) {
      if (conditional) continue;
      conditional = !!value(el.getAttribute("wx:elif")!, scope);
      if (!conditional) continue;
    } else conditional = null;
    if (el.hasAttribute("wx:for")) {
      const arr = value(el.getAttribute("wx:for")!, scope) || [];
      arr.forEach((item: unknown, index: number) => {
        const local = {
          ...scope,
          [el.getAttribute("wx:for-item") || "item"]: item,
          [el.getAttribute("wx:for-index") || "index"]: index,
        };
        renderElement(el, local, parent);
      });
    } else renderElement(el, scope, parent);
  }
}
function renderElement(el: Element, scope: any, parent: Node) {
  if (el.tagName === "block") {
    renderChildren(el, scope, parent);
    return;
  }
  const mapped: Record<string, string> = {
    view: "div",
    text: "span",
    image: "img",
  };
  const out = document.createElement(mapped[el.tagName] || el.tagName);
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("wx:") || attr.name === "xmlns:wx") continue;
    if (attr.name.startsWith("bind")) {
      const event = attr.name.slice(4) === "tap" ? "click" : attr.name.slice(4);
      out.addEventListener(event, (ev) => {
        ev.stopPropagation();
        const detail = { value: (ev.target as HTMLInputElement).value };
        try {
          current?.[attr.value]?.({
            currentTarget: { dataset: (out as HTMLElement).dataset },
            detail,
          });
        } catch (error) {
          console.error(error);
          toast("操作未完成，请检查本机存储后重试");
        }
      });
      continue;
    }
    if (attr.name === "disabled") {
      (out as HTMLButtonElement).disabled = !!value(attr.value, scope);
      continue;
    }
    const v = interpolate(attr.value, scope);
    if (attr.name === "value") {
      (out as HTMLInputElement).value = v;
      continue;
    }
    if (attr.name === "mode") {
      if (v === "aspectFill") out.style.objectFit = "cover";
      if (v === "widthFix") out.style.height = "auto";
      continue;
    }
    if (attr.name === "src") {
      if (v.startsWith("local-media:")) {
        resolveBlob(v)
          .then((url) => ((out as HTMLImageElement).src = url))
          .catch(() => out.setAttribute("alt", "本机照片无法读取"));
      } else
        out.setAttribute(
          "src",
          v.startsWith("/assets/") ? "/miniprogram" + v : v,
        );
      continue;
    }
    if (attr.name === "type" && v === "number") {
      out.setAttribute("inputmode", "numeric");
      out.setAttribute("type", "text");
      continue;
    }
    out.setAttribute(attr.name, v);
  }
  renderChildren(el, scope, out);
  parent.appendChild(out);
}
function render() {
  scheduled = false;
  if (!current || !template) return;
  const active = document.activeElement as HTMLInputElement,
    field = active?.dataset?.field,
    caret = field ? active.selectionStart : null;
  const fragment = document.createDocumentFragment();
  try {
    renderChildren(template, current.data, fragment);
    root.replaceChildren(fragment);
    if (field) {
      const next = root.querySelector<HTMLInputElement>(
        `[data-field="${field}"]`,
      );
      next?.focus({ preventScroll: true });
      if (caret !== null) next?.setSelectionRange(caret, caret);
    }
  } catch (e) {
    console.error(e);
    root.innerHTML =
      '<div class="preview-error">页面渲染失败，请查看控制台。</div>';
  }
}
async function mount() {
  const ticket = ++serial;
  const hash = location.hash.replace(/^#\/?/, "") || "home";
  const [name, query] = hash.split("?");
  if (dataMode() === "live" && !livePageAllowed(name)) {
    wx.reLaunch({ url: "/pages/home/index" });
    return;
  }
  if (!names.includes(name)) return;
  current?.onHide?.();
  current?.onUnload?.();
  route = name;
  registering = name;
  await imports[`../miniprogram/pages/${name}/index.ts`]();
  if (ticket !== serial) return;
  const def = definitions[name];
  current = { ...def, data: structuredClone(def.data || {}) };
  for (const [key, fn] of Object.entries(def))
    if (typeof fn === "function") current[key] = fn.bind(current);
  const instance = current;
  current.setData = (patch: any, callback?: Function) => {
    Object.assign(instance.data, patch);
    if (current !== instance) return;
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        render();
        callback?.();
      });
    }
  };
  const raw = String(
    templates[`../miniprogram/pages/${name}/index.wxml`],
  ).replace(/&(?!(?:amp|lt|gt|quot|apos);)/g, "&amp;");
  const doc = new DOMParser().parseFromString(
    `<root xmlns:wx="urn:wx">${raw}</root>`,
    "text/xml",
  );
  if (doc.querySelector("parsererror")) {
    console.error(doc.querySelector("parsererror")?.textContent);
    root.textContent = "WXML 解析失败";
    return;
  }
  template = doc.documentElement;
  updateStyles();
  wx.setNavigationBarTitle({
    title: (configs[`../miniprogram/pages/${name}/index.json`] as any)
      ?.navigationBarTitleText,
  });
  (document.querySelector("#back") as HTMLElement).style.visibility = [
    "home",
    "project",
    "book",
    "account",
  ].includes(name)
    ? "hidden"
    : "visible";
  root.scrollTop = 0;
  current.onLoad?.(Object.fromEntries(new URLSearchParams(query)));
  if (ticket !== serial) return;
  current.onShow?.();
  if (ticket !== serial) return;
  render();
}
document
  .querySelector("#back")!
  .addEventListener("click", () => wx.navigateBack());
document.querySelector("#capsule")!.addEventListener("click", () => {
  overlay.replaceChildren();
  const box = document.createElement("div");
  box.className = "modal catalog";
  const h = document.createElement("h2");
  h.textContent = "页面预览";
  const p = document.createElement("p");
  p.textContent =
    "浏览器预览使用同一份 WXML、WXSS 和页面逻辑，不能替代微信真机验收。";
  box.append(h, p);
  for (const name of names) {
    const b = document.createElement("button");
    b.textContent = (
      configs[`../miniprogram/pages/${name}/index.json`] as any
    ).navigationBarTitleText;
    b.onclick = () => {
      overlay.replaceChildren();
      if (dataMode() === "live") {
        if (livePageAllowed(name)) location.hash = "#/" + name;
        else toast("此页面仅用于本机演示，请先切换模式");
        return;
      }
      const project = readProject();
      if (!["home", "purchase", "service"].includes(name) && !project) {
        toast("请先创建项目，或在首页体验示例项目");
        return;
      }
      let query = name === "home" ? "?browse=1" : "";
      if (["story", "edit-story"].includes(name)) {
        if (!project?.stories.length) {
          toast("请先从讲述页查看示例故事");
          return;
        }
        query = "?id=" + project.stories[0].id;
      }
      location.hash = "#/" + name + query;
    };
    box.append(b);
  }
  const close = document.createElement("button");
  close.textContent = "关闭";
  close.onclick = () => overlay.replaceChildren();
  box.append(close);
  overlay.append(box);
});
window.addEventListener("hashchange", () => void mount());
void mount();

document
  .querySelector("#preview-width")!
  .addEventListener("change", (event) => {
    const width = Number((event.target as HTMLSelectElement).value);
    phone.style.width = width + "px";
    phone.style.height = Math.round((width * 844) / 390) + "px";
  });
