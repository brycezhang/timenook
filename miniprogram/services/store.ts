import {
  createProject,
  sampleProject,
  type Project,
  type Recipient,
} from "../domain/model";
import { dataMode, livePageAllowed } from "./mode";
import { isProjectTab, switchProjectTab } from "./navigation";
const KEY = "timenook.frontend.v1";
interface Library {
  version: 2;
  activeProjectId: string | null;
  projects: Project[];
}
function library(): Library {
  if (dataMode() === "live")
    throw new Error("真实模式不能读取或创建本机演示资料");
  const value = wx.getStorageSync(KEY);
  if (!value) return { version: 2, activeProjectId: null, projects: [] };
  // Read the original single-project format without changing its contents.
  if (value.id && Array.isArray(value.stories))
    return { version: 2, activeProjectId: value.id, projects: [value] };
  if (value.version === 2 && Array.isArray(value.projects)) return value;
  throw new Error("本机项目资料无法读取，请勿清除数据");
}
export function list(): Project[] {
  return library().projects;
}
export function read(id?: string): Project | null {
  const data = library();
  return (
    data.projects.find((p) => p.id === (id ?? data.activeProjectId)) ?? null
  );
}
export function save(p: Project) {
  const data = library();
  const index = data.projects.findIndex((item) => item.id === p.id);
  if (index < 0) throw new Error("项目不存在，无法保存");
  data.projects[index] = p;
  wx.setStorageSync(KEY, data);
  return p;
}
function add(p: Project) {
  const data = library();
  while (data.projects.some((item) => item.id === p.id)) p.id += "-new";
  data.projects.push(p);
  data.activeProjectId = p.id;
  // One write atomically preserves previous projects and selects the new one.
  wx.setStorageSync(KEY, data);
  return p;
}
export function select(id: string) {
  const data = library();
  const p = data.projects.find((item) => item.id === id);
  if (!p) throw new Error("项目不存在");
  data.activeProjectId = p.id;
  wx.setStorageSync(KEY, data);
  return p;
}
export function start(recipient: Recipient) {
  return add(createProject(recipient));
}
export function demo(recipient: Recipient = "妈妈") {
  const existing = list().find((p) => p.sample && p.recipient === recipient);
  return existing ? select(existing.id) : add(sampleProject(recipient));
}
export function clear() {
  const data = library();
  data.projects = data.projects.filter((p) => p.id !== data.activeProjectId);
  data.activeProjectId = data.projects[0]?.id ?? null;
  wx.setStorageSync(KEY, data);
}
export function required() {
  const p = read();
  if (!p) throw new Error("请先创建项目");
  return p;
}
export function go(page: string, query = "") {
  if (dataMode() === "live" && !livePageAllowed(page)) {
    home("home");
    return;
  }
  if (isProjectTab(page)) {
    switchProjectTab(page, /(?:^|&)projectId=([^&]*)/.exec(query)?.[1]);
    return;
  }
  wx.navigateTo({ url: `/pages/${page}/index${query ? "?" + query : ""}` });
}
export function home(page = "project") {
  if (dataMode() === "live") page = "home";
  if (isProjectTab(page)) {
    switchProjectTab(page);
    return;
  }
  wx.reLaunch({ url: `/pages/${page}/index` });
}
export function toast(title: string) {
  wx.showToast({ title, icon: "none" });
}
export function notify(title: string, content: string) {
  wx.showModal({ title, content, showCancel: false });
}
export function asset(p: Project | null) {
  return p?.recipient === "爸爸"
    ? "/assets/father-book.jpg"
    : "/assets/book.jpg";
}
