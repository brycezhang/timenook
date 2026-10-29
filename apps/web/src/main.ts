import "./style.css";
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
    '<div class="section-heading"><h1>我的故事书</h1><button class="quiet" type="button">退出</button></div><p class="description" role="status">正在打开你的项目…</p>',
  );
  root.querySelector("button")!.addEventListener("click", () => void logout());
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
