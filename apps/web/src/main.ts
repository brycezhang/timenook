import "./style.css";
import {
  webApi,
  withWebSession,
  onWebSessionChange,
  WebApiError,
  type WebSession,
} from "./api";
import type { AccountLinkChallenge } from "../../../packages/contracts/src/account-link";
import familyImage from "../../../miniprogram/assets/family.jpg";
import bookImage from "../../../miniprogram/assets/book.jpg";
import fatherBookImage from "../../../miniprogram/assets/father-book.jpg";

const root = document.querySelector<HTMLElement>("#app")!;
const entryPath = location.pathname;
const initialFragment = new URLSearchParams(location.hash.slice(1));
let ticket = initialFragment.get("ticket");
if (
  location.hash &&
  (initialFragment.has("ticket") || !location.hash.startsWith("#/"))
)
  history.replaceState(null, "", "/app/login");
let currentSession: WebSession | undefined;
let generation = 0;
let stopProduct: (() => void) | undefined;
let checkingOwner: WebSession | undefined;
let mockEnabled = false;

function screen(content: string, className = "") {
  const stop = stopProduct;
  stopProduct = undefined;
  stop?.();
  document.body.classList.remove("product-body");
  root.innerHTML = `<header class="site-header"><a class="brand" href="/">时光里</a><span>岁月成书</span></header><main class="${className}">${content}</main>`;
  if (document.hidden && currentSession)
    root.querySelector<HTMLElement>("main")!.style.visibility = "hidden";
}
function sessionChangedScreen() {
  screen(
    '<h1>请重新打开项目</h1><p class="description">账号已变化或登录已失效，当前资料已清空。</p><a class="product-home" href="/app/projects">重新打开我的故事书</a><button class="quiet" type="button">退出</button>',
    "login-screen",
  );
  root.querySelector("button")!.onclick = () => void logout();
}
async function verifyVisibleSession() {
  const proof = currentSession,
    owner = generation;
  if (!proof || checkingOwner === proof) return;
  checkingOwner = proof;
  const main = root.querySelector<HTMLElement>("main")!;
  const wasHidden = main.style.visibility === "hidden";
  const status = document.createElement("p");
  status.className = "session-checking";
  status.setAttribute("role", "status");
  status.textContent = "正在核对账号…";
  if (wasHidden) root.append(status);
  try {
    await withWebSession(proof, async () => {});
    if (currentSession === proof && generation === owner)
      main.style.visibility = document.hidden ? "hidden" : "";
  } catch {
    if (currentSession === proof && generation === owner) {
      generation++;
      currentSession = undefined;
      sessionChangedScreen();
    }
  } finally {
    status.remove();
    if (checkingOwner === proof) checkingOwner = undefined;
  }
}
function notice(message: string, error = false) {
  const p = document.createElement("p");
  p.className = error ? "notice error" : "notice";
  p.setAttribute("role", error ? "alert" : "status");
  p.textContent = message;
  root.querySelector("main")!.append(p);
}
function loginScreen(message?: string) {
  currentSession = undefined;
  const validTicket = !!ticket && /^[A-Za-z0-9_-]{43}$/.test(ticket);
  screen(
    `${mockEnabled && !validTicket ? `<img class="login-photo" src="${familyImage}" alt="家人相伴的温暖时刻，效果示意" />` : ""}<h1>${mockEnabled && !validTicket ? "把生命的故事，<br>温柔收藏" : "打开你的故事书"}</h1>
    <p class="description">${validTicket ? "点击下方按钮，进入本次内测。" : "请从内测登录链接进入。"}</p>
    ${validTicket ? '<button class="primary" type="button">进入我的故事书</button>' : mockEnabled ? '<p class="login-intro">说一段往事，留一段原声。<br>和重要的人，慢慢写成一本人生书。</p><button class="primary mock-login" type="button">进入内测</button><p class="experience-note">点击进入专属内测账号，无需微信授权。</p>' : '<p class="description">请向本次验收负责人获取登录链接。</p>'}`,
    "login-screen",
  );
  if (mockEnabled && !validTicket) root.querySelector(".description")?.remove();
  if (message) notice(message, true);
  root.querySelector("button")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    const owner = ++generation;
    try {
      const result = validTicket
        ? await webApi.login(ticket!)
        : await webApi.mockLogin();
      if (owner !== generation) return;
      ticket = null;
      currentSession = result;
      const invitation = /^\/app\/invitation\/([A-Za-z0-9_-]{43})\/?$/.exec(
        entryPath,
      );
      if (invitation) {
        await productScreen(owner, `welcome?token=${invitation[1]}`);
        return;
      }
      history.replaceState(null, "", "/app/projects");
      await projectsScreen(owner);
    } catch (error) {
      if (owner !== generation) return;
      if (error instanceof WebApiError && error.status === 401) ticket = null;
      loginScreen(
        error instanceof Error ? error.message : "服务暂不可用，请稍后重试。",
      );
    }
  });
}
async function projectsScreen(owner: number) {
  screen(
    '<div class="section-heading"><h1>我的故事书</h1><button class="quiet" type="button">退出</button></div><p class="description">把平凡的日子，写成值得珍藏的书。</p><button class="quiet account-link-entry" type="button">关联微信小程序</button><p class="description" role="status">正在打开你的项目…</p>',
  );
  root.querySelector("button")!.addEventListener("click", () => void logout());
  root
    .querySelector(".account-link-entry")!
    .addEventListener("click", () => void linkScreen(++generation));
  try {
    const proof = currentSession;
    if (!proof) return;
    const projects = await webApi.projects(proof);
    if (owner !== generation || !currentSession) return;
    root.querySelector("[role=status]")?.remove();
    if (mockEnabled) {
      const create = document.createElement("button");
      create.className = "primary new-book";
      create.textContent = projects.length
        ? "再为重要的人，留一本书"
        : "开始制作我的故事书";
      create.onclick = () => purchaseScreen(++generation);
      if (!projects.length) {
        const image = document.createElement("img");
        image.className = "empty-book-image";
        image.src = bookImage;
        image.alt = "人生故事书装帧效果示意";
        root.querySelector("main")!.append(image);
      }
      root.querySelector("main")!.append(create);
    }
    if (!projects.length) {
      if (!mockEnabled) notice("还没有人生项目。项目准备好后，会出现在这里。");
      return;
    }
    const list = document.createElement("ul");
    list.className = "project-list";
    for (const project of projects) {
      const item = document.createElement("li");
      const title = document.createElement("h2");
      title.textContent = project.bookTitle || "岁月成书";
      const role = document.createElement("span");
      role.className = "role";
      role.textContent =
        project.role === "initiator" ? "我是发起人" : "我是讲述者";
      item.append(title, role);
      const cover = document.createElement("img");
      cover.src = bookImage;
      cover.alt = "故事书装帧示意";
      item.prepend(cover);
      const open = document.createElement("a");
      open.className = "open-project";
      open.href = `/app/project/${project.id}`;
      open.textContent = "打开故事书";
      item.append(open);
      list.append(item);
    }
    root.querySelector("main")!.append(list);
  } catch (error) {
    if (owner !== generation) return;
    if (error instanceof WebApiError && error.status === 401) {
      loginScreen("登录已失效，请重新获取登录链接。");
    } else {
      root.querySelector("[role=status]")?.remove();
      notice("项目暂时无法打开，请稍后重试。", true);
      const retry = document.createElement("button");
      retry.className = "quiet";
      retry.textContent = "重新打开";
      retry.onclick = () => void projectsScreen(++generation);
      root.querySelector("main")!.append(retry);
    }
  }
}
function purchaseScreen(owner: number) {
  if (!currentSession || !mockEnabled) return;
  history.replaceState(null, "", "/app/purchase");
  screen(
    `<button class="text-back" type="button">‹ 返回我的故事书</button>
    <h1>这本书，你想送给谁？</h1><p class="description">让爱有迹可循，让时光有处安放。</p>
    <div class="recipient-options"><button class="recipient selected" data-name="妈妈" type="button">送给妈妈<small>她的温柔，值得被记住</small></button><button class="recipient" data-name="爸爸" type="button">送给爸爸<small>他的故事，想慢慢听</small></button></div>
    <label class="custom-recipient">也可以自定义称呼<input maxlength="40" placeholder="例如：爱人、朋友，或我自己" /></label>
    <section class="package-paper"><img class="package-cover" src="${bookImage}" alt="故事书装帧效果示意" /><div><h2 class="recipient-book-title">妈妈的一生</h2><p>爱与岁月的故事</p></div><ul><li>语音讲述，整理人生故事</li><li>照片与原声，一起留下</li><li>专属故事书，长久珍藏</li></ul></section>
    <p class="description">每次说一小段，慢慢完成。故事经本人确认后，再收进书里。</p>
    <label class="agreement"><input type="checkbox" />我已了解服务内容与内测说明</label><p class="experience-note">内测模拟支付，不会扣款；创建真实内测项目，暂不制作实体书。</p>
    <footer class="checkout-dock"><div class="checkout-price">¥999<small>一个项目 · 首本一本</small></div><button class="primary pay-button" type="button" disabled>模拟支付，创建项目</button></footer>`,
    "purchase-screen",
  );
  let recipient = "妈妈";
  root.querySelector(".text-back")!.addEventListener("click", () => {
    history.replaceState(null, "", "/app/projects");
    void projectsScreen(++generation);
  });
  const input = root.querySelector<HTMLInputElement>(
    ".custom-recipient input",
  )!;
  const update = () => {
    root.querySelector(".recipient-book-title")!.textContent =
      `${recipient}的一生`;
    root.querySelector<HTMLImageElement>(".package-cover")!.src =
      recipient === "爸爸" ? fatherBookImage : bookImage;
    root.querySelector<HTMLButtonElement>(".pay-button")!.disabled =
      !recipient.trim() ||
      !root.querySelector<HTMLInputElement>(".agreement input")!.checked;
  };
  root.querySelectorAll<HTMLButtonElement>(".recipient").forEach(
    (button) =>
      (button.onclick = () => {
        root
          .querySelectorAll(".recipient")
          .forEach((b) => b.classList.remove("selected"));
        button.classList.add("selected");
        recipient = button.dataset.name!;
        input.value = "";
        update();
      }),
  );
  input.oninput = () => {
    recipient = input.value.trim();
    root
      .querySelectorAll(".recipient")
      .forEach((b) => b.classList.remove("selected"));
    update();
  };
  root.querySelector<HTMLInputElement>(".agreement input")!.onchange = update;
  root.querySelector<HTMLButtonElement>(".pay-button")!.onclick = () => {
    const dialog = document.createElement("dialog");
    dialog.className = "payment-dialog";
    dialog.innerHTML =
      '<h2>内测模拟支付</h2><p class="checkout-price">¥999.00</p><p class="description">内测模拟支付，不会产生真实扣款。</p><button class="primary confirm-pay" type="button">确认支付（模拟）</button><button class="quiet cancel-pay" type="button">取消支付</button>';
    root.append(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(".cancel-pay")!.onclick = () =>
      dialog.remove();
    dialog.querySelector<HTMLButtonElement>(".confirm-pay")!.onclick = () => {
      dialog.remove();
      const checkout = { purchaseKey: crypto.randomUUID(), recipient };
      sessionStorage.setItem(
        "timenook.mock-checkout",
        JSON.stringify(checkout),
      );
      createProjectScreen(owner, checkout);
    };
  };
}
function createProjectScreen(
  owner: number,
  checkout: { purchaseKey: string; recipient: string },
) {
  if (!currentSession || !mockEnabled) return;
  history.replaceState(null, "", "/app/create");
  screen(
    '<div class="payment-success">✓</div><p class="payment-success-label">模拟支付成功 · 未扣款</p><h1>给故事，一个名字</h1><p class="description">现在不用想得很完整，之后还可以修改。</p><form class="create-project-form"><label>这本书的主人公<input name="subjectName" maxlength="40" required /></label><label>书名<input name="bookTitle" maxlength="80" required /></label><button class="primary" type="submit">创建我的故事书</button></form><p class="experience-note">项目资料会保存到云端。邀请、本人授权和故事确认将在项目中分别完成。</p>',
    "create-screen",
  );
  const form = root.querySelector<HTMLFormElement>("form")!;
  form.querySelector<HTMLInputElement>('[name="subjectName"]')!.value =
    checkout.recipient;
  form.querySelector<HTMLInputElement>('[name="bookTitle"]')!.value =
    `${checkout.recipient}的一生`;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const proof = currentSession;
    if (!proof || owner !== generation) return;
    const button = form.querySelector<HTMLButtonElement>("button")!;
    button.disabled = true;
    button.textContent = "正在创建…";
    root.querySelector(".notice")?.remove();
    try {
      const values = new FormData(form);
      const result = await webApi.mockPurchase(proof, {
        purchaseKey: checkout.purchaseKey,
        subjectName: String(values.get("subjectName")).trim(),
        bookTitle: String(values.get("bookTitle")).trim(),
      });
      if (owner !== generation || currentSession !== proof) return;
      sessionStorage.removeItem("timenook.mock-checkout");
      location.assign(`/app/project/${result.projectId}`);
    } catch (error) {
      if (owner !== generation) return;
      notice(
        error instanceof Error ? error.message : "创建未完成，请重试。",
        true,
      );
      button.disabled = false;
      button.textContent = "创建我的故事书";
    }
  };
}
async function productScreen(owner: number, initialPage: string) {
  if (!currentSession) return;
  screen(
    `<nav class="app-side" aria-label="主导航"><p class="side-title">当前人生项目<br><strong id="current-project-title">正在打开…</strong></p>${[
      ["project", "book-open", "故事书"],
      ["book", "file-text", "成书"],
      ["account", "user", "我的"],
    ]
      .map(
        ([page, icon, label]) =>
          `<a class="side-link" data-product-page="${page}"><img src="${new URL(`../../../miniprogram/assets/icons/${icon}.svg`, import.meta.url).href}" alt="">${label}</a>`,
      )
      .join(
        "",
      )}<div class="side-bottom">慢慢说，不必赶。<br>制作、回听与下载长期有效。</div></nav><section id="phone"><header id="native-header"><div class="navbar"><button id="back" aria-label="返回">‹</button><span id="nav-title">岁月成书</span></div></header><div id="page"></div><div id="overlay"></div></section>`,
    "product-shell",
  );
  document.body.classList.add("product-body");
  const projectsLink = document.createElement("a");
  projectsLink.className = "header-projects";
  projectsLink.href = "/app/projects";
  projectsLink.textContent = "我的故事书";
  root.querySelector(".site-header")!.append(projectsLink);
  document.body.style.setProperty(
    "--site-header-height",
    `${root.querySelector(".site-header")!.getBoundingClientRect().height}px`,
  );
  const [{ installCookieProductSession }, { mountMiniProgram }] =
    await Promise.all([
      import("./product-session"),
      import("../../../preview/runtime"),
    ]);
  if (owner !== generation || !currentSession) return;
  const client = installCookieProductSession(currentSession);
  const stopRuntime = mountMiniProgram({
    product: true,
    initialPage,
    onExit: () => location.assign("/app/projects"),
  });
  const stopOwner = client.onInvalidated(() => {
    if (owner !== generation) return;
    generation++;
    currentSession = undefined;
    sessionChangedScreen();
  });
  stopProduct = () => {
    stopOwner();
    stopRuntime();
    client.closeCookieSession();
  };
}
async function assertLinkOwner(owner: number, expected: WebSession) {
  const restored = await webApi.restore();
  if (owner !== generation) return false;
  if (
    !currentSession ||
    restored.session.id !== expected.session.id ||
    restored.user.id !== expected.user.id
  ) {
    generation++;
    loginScreen("账号已切换，请重新打开当前账号后再关联。");
    return false;
  }
  return true;
}
async function linkScreen(
  owner: number,
  challenge?: AccountLinkChallenge,
  code?: string,
) {
  const expected = currentSession;
  if (!expected) return;
  screen(
    '<div class="section-heading"><h1>关联微信小程序</h1><button class="quiet" type="button">返回项目</button></div><p class="description">关联后使用同一产品账号和原有项目。关联不代替讲述者本人对任何用途的授权。</p><p role="status">正在检查关联服务…</p>',
  );
  root.querySelector("button")!.onclick = async () => {
    if (challenge && ["waiting", "paired"].includes(challenge.state)) {
      try {
        await webApi.link(challenge.id, "cancel", expected.csrfToken);
      } catch {
        /* Expiry and revoked sessions already prevent attachment. */
      }
    }
    if (owner === generation) void projectsScreen(++generation);
  };
  try {
    if (!(await assertLinkOwner(owner, expected))) return;
    const available = await webApi.linkAvailability();
    if (!(await assertLinkOwner(owner, expected))) return;
    root.querySelector("[role=status]")!.remove();
    if (!available) {
      notice("独立小程序尚未配置，暂不可关联。正式微信验证仍待完成。");
      return;
    }
    const panel = document.createElement("section");
    panel.className = "link-panel";
    const run = async (action: () => Promise<void>) => {
      panel
        .querySelectorAll("button")
        .forEach((button) => (button.disabled = true));
      try {
        if (await assertLinkOwner(owner, expected)) await action();
      } catch (error) {
        if (owner !== generation) return;
        if (error instanceof WebApiError && [401, 403].includes(error.status)) {
          generation++;
          loginScreen("网页会话已失效或账号已切换，请重新打开后再关联。");
        } else {
          notice(
            error instanceof Error ? error.message : "关联失败，请稍后重试。",
            true,
          );
          panel
            .querySelectorAll("button")
            .forEach((button) => (button.disabled = false));
        }
      }
    };
    const button = (
      label: string,
      action: () => Promise<void>,
      primary = false,
    ) => {
      const control = document.createElement("button");
      control.type = "button";
      control.className = primary ? "primary" : "quiet";
      control.textContent = label;
      control.onclick = () => void run(action);
      panel.append(control);
    };
    if (!challenge) {
      button(
        "生成短期关联码",
        async () => {
          const result = await webApi.createLink(expected.csrfToken);
          if (await assertLinkOwner(owner, expected))
            await linkScreen(owner, result.challenge, result.challenge.code);
        },
        true,
      );
    } else {
      const text = (content: string, className = "") => {
        const p = document.createElement("p");
        p.textContent = content;
        p.className = className;
        panel.append(p);
      };
      text(`目标网页账号：${challenge.targetUser.id}`, "account-id");
      if (code && challenge.state === "waiting") {
        text(code, "pair-code");
        text(
          "在小程序首页选择“关联已有网页账号”，输入这8位关联码。5分钟内有效。",
        );
      }
      if (challenge.verificationCode) {
        text(challenge.verificationCode, "pair-code");
        text(
          "请当面核对小程序上相同的6位核对码，再分别确认。仅关联你自己的账号。",
        );
      }
      if (challenge.state === "linked")
        text(
          "两端已确认，关联完成。请在小程序重新微信登录同一账号。",
          "notice",
        );
      else if (["cancelled", "expired"].includes(challenge.state)) {
        text("本次关联已取消或到期，没有继续关联。");
        button("重新发起关联", async () => {
          await linkScreen(owner);
        });
      } else {
        text(
          `网页${challenge.webConfirmed ? "已确认" : "待确认"} · 小程序${challenge.nativeConfirmed ? "已确认" : "待确认"}`,
        );
        if (challenge.state === "paired" && !challenge.webConfirmed) {
          const label = document.createElement("label");
          label.textContent = "输入小程序上的6位核对码";
          const input = document.createElement("input");
          input.inputMode = "numeric";
          input.maxLength = 6;
          input.autocomplete = "off";
          label.append(input);
          panel.append(label);
          button(
            "核对一致，确认关联",
            async () => {
              if (!/^\d{6}$/.test(input.value))
                throw new Error("请输入小程序上的6位核对码。");
              const result = await webApi.link(
                challenge.id,
                "confirm",
                expected.csrfToken,
                input.value,
              );
              if (await assertLinkOwner(owner, expected))
                await linkScreen(owner, result.challenge);
            },
            true,
          );
        }
        button("刷新关联状态", async () => {
          const result = await webApi.link(challenge.id);
          if (await assertLinkOwner(owner, expected))
            await linkScreen(owner, result.challenge, code);
        });
        button("取消关联", async () => {
          const result = await webApi.link(
            challenge.id,
            "cancel",
            expected.csrfToken,
          );
          if (await assertLinkOwner(owner, expected))
            await linkScreen(owner, result.challenge);
        });
      }
    }
    root.querySelector("main")!.append(panel);
  } catch (error) {
    if (owner !== generation) return;
    if (error instanceof WebApiError && [401, 403].includes(error.status)) {
      generation++;
      loginScreen("网页会话已失效，请重新打开后再关联。");
    } else {
      root.querySelector("[role=status]")?.remove();
      notice("关联服务暂不可用，请稍后重试。", true);
    }
  }
}
async function logout() {
  const previous = currentSession;
  const owner = ++generation;
  currentSession = undefined;
  screen(
    '<h1>正在退出</h1><p class="description" role="status">正在结束本次会话…</p>',
    "login-screen",
  );
  try {
    if (previous) await webApi.logout(previous.csrfToken);
    if (owner !== generation) return;
    history.replaceState(null, "", "/app/login");
    loginScreen();
  } catch {
    if (owner !== generation) return;
    screen(
      '<h1>退出尚未确认</h1><p class="description">当前页面的私人资料已清空，请重试退出。</p><button class="primary" type="button">重试退出</button>',
      "login-screen",
    );
    root.querySelector("button")!.onclick = () => {
      currentSession = previous;
      void logout();
    };
  }
}
async function start() {
  const owner = ++generation;
  try {
    mockEnabled = await webApi.experience();
  } catch {
    mockEnabled = false;
  }
  if (owner !== generation) return;
  if (ticket) {
    loginScreen(
      /^[A-Za-z0-9_-]{43}$/.test(ticket)
        ? undefined
        : "登录链接无效，请重新获取。",
    );
    return;
  }
  screen(
    '<h1>打开你的故事书</h1><p class="description" role="status">正在恢复会话…</p>',
    "login-screen",
  );
  try {
    const result = await webApi.restore();
    if (owner !== generation) return;
    // A new fragment may arrive while restore is in flight. Leave it for the
    // hashchange handler before history replacement can erase its ticket.
    if (new URLSearchParams(location.hash.slice(1)).has("ticket")) return;
    currentSession = result;
    if (mockEnabled && location.pathname === "/app/purchase") {
      purchaseScreen(owner);
      return;
    }
    if (mockEnabled && location.pathname === "/app/create") {
      try {
        const checkout = JSON.parse(
          sessionStorage.getItem("timenook.mock-checkout") ?? "null",
        );
        if (
          checkout &&
          /^[0-9a-f-]{36}$/.test(checkout.purchaseKey) &&
          typeof checkout.recipient === "string"
        ) {
          createProjectScreen(owner, checkout);
          return;
        }
      } catch {
        /* A missing local checkout starts from the package again. */
      }
      purchaseScreen(owner);
      return;
    }
    const project = /^\/app\/project\/([a-f0-9-]{36})\/?$/.exec(
      location.pathname,
    );
    const audio = /^\/app\/audio\/([A-Za-z0-9_-]{22})\/?$/.exec(
      location.pathname,
    );
    const invitation = /^\/app\/invitation\/([A-Za-z0-9_-]{43})\/?$/.exec(
      location.pathname,
    );
    if (project) await productScreen(owner, `project?projectId=${project[1]}`);
    else if (audio)
      await productScreen(owner, `original-audio?entryId=${audio[1]}`);
    else if (invitation)
      await productScreen(owner, `welcome?token=${invitation[1]}`);
    else {
      history.replaceState(null, "", "/app/projects");
      await projectsScreen(owner);
    }
  } catch (error) {
    if (owner !== generation) return;
    loginScreen(
      error instanceof WebApiError && error.status === 401
        ? undefined
        : "服务暂不可用，请稍后重试。",
    );
  }
}
window.addEventListener("pagehide", () => {
  generation++;
  currentSession = undefined;
  screen("<h1>打开你的故事书</h1>", "login-screen");
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
window.addEventListener("hashchange", () => {
  const next = new URLSearchParams(location.hash.slice(1)).get("ticket");
  if (!next) return;
  generation++;
  currentSession = undefined;
  ticket = next;
  history.replaceState(null, "", "/app/login");
  void start();
});
onWebSessionChange(() => void verifyVisibleSession());
window.addEventListener("focus", () => void verifyVisibleSession());
document.addEventListener("visibilitychange", () => {
  if (document.hidden && currentSession)
    root.querySelector<HTMLElement>("main")!.style.visibility = "hidden";
  else void verifyVisibleSession();
});
void start();
