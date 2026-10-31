import { dataMode } from "./mode";
import { projectOverviewClient } from "./project-overview";

export const PROJECT_TABS = ["project", "book", "account"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
export function isProjectTab(page: string): page is ProjectTab {
  return PROJECT_TABS.includes(page as ProjectTab);
}

export function switchProjectTab(page: ProjectTab, projectId = "") {
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
  projectTitle = "项目",
) {
  page.getTabBar?.()?.setData({ selected, projectTitle });
}
