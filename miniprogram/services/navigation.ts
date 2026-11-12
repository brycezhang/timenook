import { resetQuestionSession } from "./question-recommendations";
import { dataMode, livePageAllowed } from "./mode";
import { projectOverviewClient } from "./project-overview";

export const PROJECT_TABS = ["home", "account"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
export function isProjectTab(page: string): page is ProjectTab {
  return PROJECT_TABS.includes(page as ProjectTab);
}

export function switchProjectTab(page: ProjectTab, projectId = "") {
  if (page === "account" || projectId) resetQuestionSession();
  // switchTab cannot carry a query. The existing selection is scoped to the
  // current authenticated session and is read again by cached tab pages.
  if (dataMode() === "live" && projectId)
    projectOverviewClient.select(projectId);
  wx.switchTab({ url: `/pages/${page}/index` });
}

export function tabProjectId(explicit = "") {
  if (explicit) {
    if (/^[0-9a-f-]{36}$/.test(explicit))
      projectOverviewClient.select(explicit);
    return explicit;
  }
  return projectOverviewClient.selected();
}

export function showProjectTab(
  page: { getTabBar?: () => { setData(data: object): void } },
  selected: ProjectTab,
  projectTitle = "故事书",
) {
  page.getTabBar?.()?.setData({ selected, projectTitle });
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
export function home(page = "home") {
  if (dataMode() === "live") page = "home";
  if (isProjectTab(page)) {
    switchProjectTab(page);
    return;
  }
  wx.reLaunch({ url: `/pages/${page}/index` });
}
