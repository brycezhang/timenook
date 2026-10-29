import "./style.css";
import type { AccountLinkChallenge } from "../../../packages/contracts/src/account-link";
import { webApi, WebApiError, type WebSession } from "./api";

const root = document.querySelector<HTMLElement>("#app")!;
let ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
if (location.hash) history.replaceState(null, "", "/app/login");
let currentSession: WebSession | undefined;
let generation = 0;

function screen(content: string, className = "") {
  root.innerHTML = `<header class="site-header"><a class="brand" href="/">时光里</a><span>岁月成书</span></header><main class="${className}">${content}</main>`;
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
    `<h1>打开你的故事书</h1>
    <p class="description">${validTicket ? "点击下方按钮，进入本次内测。" : "请从内测登录链接进入。"}</p>
    ${validTicket ? '<button class="primary" type="button">进入我的故事书</button>' : '<p class="description">请向本次验收负责人获取登录链接。</p>'}`,
    "login-screen",
  );
  if (message) notice(message, true);
  root.querySelector("button")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    const owner = ++generation;
    try {
      const result = await webApi.login(ticket!);
      if (owner !== generation) return;
      ticket = null;
      currentSession = result;
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
    '<div class="section-heading"><h1>我的故事书</h1><button class="quiet" type="button">退出</button></div><button class="quiet account-link-entry" type="button">关联微信小程序</button><p class="description" role="status">正在打开你的项目…</p>',
  );
  root.querySelector("button")!.addEventListener("click", () => void logout());
  root
    .querySelector(".account-link-entry")!
    .addEventListener("click", () => void linkScreen(++generation));
  try {
    const projects = await webApi.projects();
    if (owner !== generation || !currentSession) return;
    root.querySelector("[role=status]")?.remove();
    if (!projects.length) {
      notice("还没有人生项目。项目准备好后，会出现在这里。");
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
    history.replaceState(null, "", "/app/projects");
    await projectsScreen(owner);
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
  if (event.persisted) void start();
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
void start();
