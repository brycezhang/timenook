import "./base.css";
import { read as readProject } from "../miniprogram/services/store";
import { dataMode, livePageAllowed } from "../miniprogram/services/mode";
import { closePdfDocument, openPdfDocument } from "./pdf-viewer";
import {
  createRecorder,
  createAudio,
  temporaryFile,
  saveBlob,
  writeBlob,
  resolveBlob,
  removeBlob,
} from "./media";

export function mountMiniProgram(
  options: {
    product?: boolean;
    initialPage?: string;
    onExit?: () => void;
  } = {},
) {
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
  const assets = import.meta.glob("../miniprogram/assets/**/*", {
    query: "?url",
    import: "default",
    eager: true,
  });
  const names = Object.keys(imports).map((k) => k.split("/")[3]);
  let current: any = null,
    route = "",
    template: Element | null = null,
    serial = 0,
    scheduled = false,
    composing = false;
  const definitions: Record<string, any> = {};
  let registering = "";
  let pageLoad = Promise.resolve();
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
  const observer = new ResizeObserver(updateStyles);
  observer.observe(phone);
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
    getAccountInfoSync() {
      return {
        miniProgram: {
          appId: options.product ? "browser-web" : "browser-preview",
        },
      };
    },
    getStorageSync(key: string) {
      if (options.product && key === "timenook.mode.v1") return "live";
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
      const photoPath =
        /\/v1\/projects\/[a-f0-9-]{36}\/interviews\/[a-f0-9-]{36}\/photos/;
      const photoSupported =
        photoPath.test(url.pathname) &&
        (((!options.method || options.method === "GET") &&
          /\/photos(?:\/materials\/[a-f0-9-]{36})?$/.test(url.pathname)) ||
          (options.method === "POST" &&
            /\/photos(?:\/(?:context|materials)|\/[a-f0-9-]{36}\/(?:upload|seal|status|release|crop))?$/.test(
              url.pathname,
            )));
      const storyConfirmationSupported =
        ((!options.method || options.method === "GET") &&
          /\/v1\/projects\/[a-f0-9-]{36}\/overview$/.test(url.pathname)) ||
        (options.method === "POST" &&
          /\/v1\/projects\/[a-f0-9-]{36}\/(?:metadata|stories\/[a-f0-9-]{36}\/(?:revisions|decisions|care-access))$/.test(
            url.pathname,
          ));
      const supported =
        ((!options.method ||
          options.method === "GET" ||
          options.method === "POST") &&
          /\/v1\/orders\/[a-f0-9-]{36}\/quality-care(?:\/[a-f0-9-]{36}\/(?:access|refund))?$/.test(
            url.pathname,
          )) ||
        ((!options.method ||
          options.method === "GET" ||
          options.method === "POST") &&
          /\/v1\/projects\/[a-f0-9-]{36}\/exports$/.test(url.pathname)) ||
        (options.method === "POST" &&
          /\/v1\/projects\/[a-f0-9-]{36}\/exports\/[a-f0-9-]{36}\/receipt$/.test(
            url.pathname,
          )) ||
        ((!options.method ||
          options.method === "GET" ||
          options.method === "POST") &&
          /\/v1\/orders\/[a-f0-9-]{36}\/refunds$/.test(url.pathname)) ||
        ((!options.method || options.method === "GET") &&
          /\/v1\/projects\/[a-f0-9-]{36}\/(?:fulfillment|withdrawal-status)$/.test(
            url.pathname,
          )) ||
        (options.method === "POST" &&
          /\/v1\/projects\/[a-f0-9-]{36}\/fulfillment\/grants$/.test(
            url.pathname,
          )) ||
        ((!options.method || options.method === "GET") &&
          /\/v1\/projects\/[a-f0-9-]{36}\/first-copy$/.test(url.pathname)) ||
        (options.method === "POST" &&
          /\/v1\/projects\/[a-f0-9-]{36}\/first-copy\/(?:address|confirmations|submit|expiry-review)$/.test(
            url.pathname,
          )) ||
        ((!options.method || options.method === "GET") &&
          /\/v1\/book-audio\/[A-Za-z0-9_-]{22}$/.test(url.pathname)) ||
        ((!options.method || options.method === "GET") &&
          /\/v1\/projects\/[a-f0-9-]{36}\/book(?:\/versions\/[a-f0-9-]{36})?$/.test(
            url.pathname,
          )) ||
        (options.method === "POST" &&
          /\/v1\/projects\/[a-f0-9-]{36}\/book\/(?:cover|directory|versions(?:\/[a-f0-9-]{36}\/retry)?)$/.test(
            url.pathname,
          )) ||
        storyConfirmationSupported ||
        photoSupported ||
        ((!options.method || options.method === "GET") &&
          /\/v1\/(recipient-types|packages\/current|orders(?:\/[a-f0-9-]{36})?|participations|invitations\/[A-Za-z0-9_-]{43}|projects\/[a-f0-9-]{36}\/(?:stories\/[a-f0-9-]{36}|participation|binding-requests|care-requests|deletion-status|assisted-sessions|tasks(?:\/[a-f0-9-]{36})?|plan|interviews(?:\/[a-f0-9-]{36}(?:\/clips\/[a-f0-9-]{36}(?:\/content)?)?)?))$/.test(
            url.pathname,
          )) ||
        (options.method === "POST" &&
          /\/v1\/(?:orders(?:\/[a-f0-9-]{36}\/(?:payment|close))?|projects\/[a-f0-9-]{36}\/(?:stories\/(?:context|organize)|invitations|consents(?:\/revoke)?|care-requests|assisted-sessions|tasks(?:\/status|\/[a-f0-9-]{36}\/retry)|plan(?:\/preferences)?|interviews(?:\/context|\/[a-f0-9-]{36}\/(?:resume|recording-start|collection-check|actual-question|follow-up(?:\/(?:status|finish))?)|\/[a-f0-9-]{36}\/clips(?:\/[a-f0-9-]{36}\/(?:upload|seal|status|release))?)?)|invitations\/[A-Za-z0-9_-]{43}\/requests|binding-requests\/[a-f0-9-]{36}\/approve)$/.test(
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
    uploadFile(options: any) {
      void (async () => {
        try {
          const url = new URL(options.url, location.origin);
          if (
            url.origin !== location.origin ||
            !/\/v1\/(recordings|photos)\/objects$/.test(url.pathname)
          )
            throw Error("Unsupported preview upload");
          const form = new FormData();
          for (const [key, value] of Object.entries(options.formData ?? {}))
            form.append(key, String(value));
          const file = await fetch(await resolveBlob(options.filePath)).then(
            (r) => r.blob(),
          );
          form.append(
            options.name,
            file,
            url.pathname.endsWith("/photos/objects")
              ? "photo.bin"
              : "recording.mp3",
          );
          const response = await fetch(url, {
            method: "POST",
            headers: options.header,
            body: form,
            credentials: "omit",
          });
          options.success?.({
            statusCode: response.status,
            data: await response.text(),
          });
        } catch {
          options.fail?.({ errMsg: "uploadFile:fail" });
        }
      })();
    },
    pageScrollTo(options: any) {
      if (options.selector)
        root
          .querySelector(options.selector)
          ?.scrollIntoView({ block: "start" });
      else root.scrollTop = options.scrollTop ?? 0;
      options.success?.({ errMsg: "pageScrollTo:ok" });
    },
    redirectTo({ url }: any) {
      history.replaceState(null, "", targetUrl(url));
      void mount();
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
    setClipboardData(o: any) {
      void navigator.clipboard.writeText(o.data).then(
        () => {
          const result = { errMsg: "setClipboardData:ok" };
          o.success?.(result);
          o.complete?.(result);
        },
        () => {
          const result = { errMsg: "setClipboardData:fail" };
          o.fail?.(result);
          o.complete?.(result);
        },
      );
    },
    showModal: modal,
    showActionSheet(options: any) {
      overlay.replaceChildren();
      const list = document.createElement("div");
      list.className = "modal action-sheet";
      options.itemList.forEach((label: string, tapIndex: number) => {
        const button = document.createElement("button");
        button.textContent = label;
        button.onclick = () => {
          overlay.replaceChildren();
          options.success?.({ tapIndex });
        };
        list.append(button);
      });
      const cancel = document.createElement("button");
      cancel.textContent = "取消";
      cancel.onclick = () => {
        overlay.replaceChildren();
        options.fail?.({ errMsg: "showActionSheet:fail cancel" });
      };
      list.append(cancel);
      overlay.append(list);
    },
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
        unlink(o: any) {
          closePdfDocument(o.filePath);
          void removeBlob(o.filePath)
            .then(() => o.success?.({}))
            .catch(() => o.fail?.({}));
        },
        access(o: any) {
          void resolveBlob(o.path)
            .then((url) => fetch(url))
            .then((r) => {
              if (!r.ok) throw Error();
              o.success?.({});
            })
            .catch((e) => o.fail?.(e));
        },
        getFileInfo(o: any) {
          void (async () => {
            try {
              const bytes = await fetch(await resolveBlob(o.filePath)).then(
                (r) => r.arrayBuffer(),
              );
              const hash = await crypto.subtle.digest("SHA-256", bytes);
              o.success?.({
                size: bytes.byteLength,
                digest: [...new Uint8Array(hash)]
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join(""),
              });
            } catch (e) {
              o.fail?.(e);
            }
          })();
        },
        saveFile(o: any) {
          saveBlob(o.tempFilePath)
            .then((savedFilePath) => o.success?.({ savedFilePath }))
            .catch((e) => o.fail?.(e));
        },
        writeFile(o: any) {
          writeBlob(
            o.filePath,
            new Blob([o.data], { type: "application/json" }),
          )
            .then(() => o.success?.())
            .catch((e) => o.fail?.(e));
        },
      };
    },
    downloadFile(o: any) {
      const url = new URL(o.url, location.origin);
      if (
        url.origin !== location.origin ||
        !(
          /\/v1\/projects\/[a-f0-9-]{36}\/interviews\/[a-f0-9-]{36}\/(?:photos\/[a-f0-9-]{36}\/assets\/[a-f0-9-]{36}|clips\/[a-f0-9-]{36})\/content$/.test(
            url.pathname,
          ) ||
          /\/v1\/projects\/[a-f0-9-]{36}\/book\/versions\/[a-f0-9-]{36}\/pdf$/.test(
            url.pathname,
          ) ||
          /\/v1\/projects\/[a-f0-9-]{36}\/exports\/[a-f0-9-]{36}\/download$/.test(
            url.pathname,
          ) ||
          (/\/v1\/book-audio\/[A-Za-z0-9_-]{22}\/clips\/[a-f0-9-]{36}\/content$/.test(
            url.pathname,
          ) &&
            /^\?epoch=\d+$/.test(url.search))
        )
      ) {
        o.fail?.({ errMsg: "downloadFile:fail" });
        return;
      }
      void fetch(url, {
        headers: o.header,
        credentials: "omit",
        signal: AbortSignal.timeout(o.timeout ?? 15000),
      })
        .then(async (response) =>
          o.success?.({
            statusCode: response.status,
            tempFilePath: temporaryFile(await response.blob()),
          }),
        )
        .catch(() => o.fail?.({ errMsg: "downloadFile:fail" }));
    },
    openDocument(o: any) {
      void openPdfDocument(overlay, o, (filePath) => {
        void removeBlob(filePath).catch(() => {});
      });
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
  function renderChildren(node: Node, scope: any, parent: Node, path = "root") {
    let childIndex = 0;
    let conditional: boolean | null = null;
    for (const child of Array.from(node.childNodes)) {
      const key = `${path}.${childIndex++}`;
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
          renderElement(el, local, parent, `${key}.${index}`);
        });
      } else renderElement(el, scope, parent, key);
    }
  }
  function renderElement(el: Element, scope: any, parent: Node, key: string) {
    if (el.tagName === "block") {
      renderChildren(el, scope, parent, key);
      return;
    }
    const mapped: Record<string, string> = {
      view: "div",
      text: "span",
      image: "img",
      "checkbox-group": "div",
      checkbox: "input",
    };
    const out = document.createElement(mapped[el.tagName] || el.tagName);
    if (["input", "textarea", "checkbox"].includes(el.tagName))
      out.dataset.renderKey = key;
    if (el.tagName === "checkbox") (out as HTMLInputElement).type = "checkbox";
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("wx:") || attr.name === "xmlns:wx") continue;
      if (attr.name === "open-type" && attr.value === "share") {
        out.addEventListener("click", () => {
          const share = current?.onShareAppMessage?.();
          if (!share) return;
          const source = new URL(share.path, location.origin);
          const token = source.searchParams.get("token");
          const url =
            options.product && token
              ? new URL(`/app/invitation/${token}`, location.origin).href
              : new URL(targetUrl(share.path), location.href).href;
          if (navigator.share) {
            void navigator.share({ title: share.title, url }).catch((error) => {
              if (error.name !== "AbortError")
                toast("分享未完成，请复制邀请链接后发送。");
            });
          } else {
            wx.setClipboardData({
              data: url,
              success: () => toast("邀请链接已复制，可以发给讲述者。"),
              fail: () => toast("复制未完成，请重试复制邀请链接。"),
            });
          }
        });
        continue;
      }
      if (attr.name.startsWith("bind")) {
        const event =
          attr.name.slice(4) === "tap" ? "click" : attr.name.slice(4);
        out.addEventListener(event, (ev) => {
          ev.stopPropagation();
          const detail = {
            value:
              el.tagName === "checkbox-group"
                ? Array.from(
                    out.querySelectorAll<HTMLInputElement>(
                      'input[type="checkbox"]:checked',
                    ),
                  ).map((input) => input.value)
                : (ev.target as HTMLInputElement).value,
          };
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
      if (attr.name === "checked") {
        (out as HTMLInputElement).checked = !!value(attr.value, scope);
        continue;
      }
      const v = interpolate(attr.value, scope);
      if (attr.name === "value") {
        (out as HTMLInputElement).value = v;
        continue;
      }
      if (attr.name === "mode") {
        if (v === "aspectFill") out.style.objectFit = "cover";
        if (v === "aspectFit") out.style.objectFit = "contain";
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
            v.startsWith("/assets/")
              ? String(assets[`../miniprogram${v}`] ?? "/miniprogram" + v)
              : v,
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
    renderChildren(el, scope, out, key);
    parent.appendChild(out);
  }
  function render() {
    scheduled = false;
    if (!current || !template || composing) return;
    const active = document.activeElement as HTMLInputElement,
      field = root.contains(active) ? active?.dataset?.renderKey : undefined,
      caret = field ? active.selectionStart : null,
      end = field ? active.selectionEnd : null,
      direction = field ? active.selectionDirection : null,
      scroll = root.scrollTop;
    const fragment = document.createDocumentFragment();
    try {
      renderChildren(template, current.data, fragment);
      root.replaceChildren(fragment);
      if (field) {
        const next = root.querySelector<HTMLInputElement>(
          `[data-render-key="${field}"]`,
        );
        next?.focus({ preventScroll: true });
        if (caret !== null && end !== null)
          next?.setSelectionRange(caret, end, direction ?? undefined);
        root.scrollTop = scroll;
      }
    } catch (e) {
      console.error(e);
      root.innerHTML =
        '<div class="preview-error">页面渲染失败，请查看控制台。</div>';
    }
  }
  const compositionStart = () => {
    composing = true;
  };
  const compositionEnd = () => {
    composing = false;
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(render);
    }
  };
  root.addEventListener("compositionstart", compositionStart);
  root.addEventListener("compositionend", compositionEnd);
  async function mount() {
    composing = false;
    const ticket = ++serial;
    const hash =
      location.hash.replace(/^#\/?/, "") || options.initialPage || "home";
    const [name, query] = hash.split("?");
    if (options.product && ["home", "purchase", "order"].includes(name)) {
      options.onExit?.();
      return;
    }
    if (dataMode() === "live" && !livePageAllowed(name)) {
      wx.reLaunch({ url: "/pages/home/index" });
      return;
    }
    if (!names.includes(name)) return;
    current?.onHide?.();
    current?.onUnload?.();
    route = name;
    // Page() has no route argument; keep its owner stable until the module loads.
    const loaded = pageLoad.then(async () => {
      registering = name;
      await imports[`../miniprogram/pages/${name}/index.ts`]();
    });
    pageLoad = loaded.catch(() => {});
    await loaded;
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
    if (document.hidden) current.onHide?.();
    else current.onShow?.();
    if (ticket !== serial) return;
    render();
  }
  document
    .querySelector("#back")!
    .addEventListener("click", () => wx.navigateBack());
  document.querySelector("#capsule")?.addEventListener("click", () => {
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
  const onHashChange = () => void mount();
  window.addEventListener("hashchange", onHashChange);
  void mount();

  document
    .querySelector("#preview-width")
    ?.addEventListener("change", (event) => {
      const width = Number((event.target as HTMLSelectElement).value);
      phone.style.width = width + "px";
      phone.style.height = Math.round((width * 844) / 390) + "px";
    });

  const onVisibility = () => {
    if (document.hidden) current?.onHide?.();
    else current?.onShow?.();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    serial++;
    current?.onHide?.();
    current?.onUnload?.();
    current = null;
    closePdfDocument();
    root.replaceChildren();
    overlay.replaceChildren();
    observer.disconnect();
    root.removeEventListener("compositionstart", compositionStart);
    root.removeEventListener("compositionend", compositionEnd);
    cssTag.remove();
    window.removeEventListener("hashchange", onHashChange);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
