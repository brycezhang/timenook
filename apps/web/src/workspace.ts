import { computed, readonly, ref, watch } from "vue";
import { auth } from "./session";
import type { ProjectSummary } from "./api";
const projects = ref<ProjectSummary[]>([]);
const selectedId = ref("");
const loading = ref(false);
const error = ref("");
let generation = 0;
let requestedId = "";
auth.onClear(() => {
  generation++;
  projects.value = [];
  selectedId.value = "";
  requestedId = "";
  error.value = "";
  loading.value = false;
});
async function refresh() {
  if (!auth.account.value) return;
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result = await auth.projects();
    if (current !== generation) return;
    projects.value = result;
    if (result.some((project) => project.projectId === requestedId))
      selectedId.value = requestedId;
    else if (!result.some((project) => project.projectId === selectedId.value))
      selectedId.value = result[0]?.projectId ?? "";
  } catch (reason) {
    if (current === generation)
      error.value =
        reason instanceof Error ? reason.message : "项目读取失败，请重试。";
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  () => auth.account.value?.session.id,
  (id) => {
    if (id) void refresh();
  },
  { immediate: true },
);
export const workspace = {
  projects: readonly(projects),
  selectedId: readonly(selectedId),
  active: computed(() =>
    projects.value.find((project) => project.projectId === selectedId.value),
  ),
  loading: readonly(loading),
  error: readonly(error),
  refresh,
  select(id: string) {
    requestedId = id;
    if (projects.value.some((project) => project.projectId === id))
      selectedId.value = id;
  },
};
