<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Alert, Button, Form, FormItem, Input } from "antdv-next";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import type {
  AdminPermission,
  ManagedRecipientType,
  PackageDraft,
  PackageDraftInput,
  PackageVersion,
} from "@timenook/contracts";
import { catalogApi } from "../api/admin";
const props = defineProps<{ csrf: string; permissions: AdminPermission[] }>();
const emit = defineEmits<{ expired: [] }>();
const canWrite = computed(() =>
  props.permissions.includes(ADMIN_PERMISSIONS.writeCatalog),
);
const canFreeze = computed(() =>
  props.permissions.includes(ADMIN_PERMISSIONS.freezeCatalog),
);
const busy = ref(false),
  error = ref(""),
  message = ref("");
const recipients = ref<ManagedRecipientType[]>([]),
  drafts = ref<PackageDraft[]>([]),
  versions = ref<PackageVersion[]>([]);
const code = ref(""),
  label = ref(""),
  sortOrder = ref("0"),
  editing = ref<ManagedRecipientType | null>(null);
const title = ref(""),
  parameters = ref<Omit<PackageDraftInput, "title">>({
    d01: {},
    admission: {},
    shippingRegionLabels: {},
  }),
  selected = ref<PackageDraft | null>(null),
  dirty = ref(false);
async function refresh() {
  [recipients.value, drafts.value, versions.value] = await Promise.all([
    catalogApi.recipients(),
    catalogApi.drafts(),
    catalogApi.versions(),
  ]);
}
async function run(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    await work();
  } catch (failure) {
    const code = (failure as { error?: { code?: string } }).error?.code;
    if (code === "UNAUTHENTICATED") emit("expired");
    else
      error.value =
        code === "CONFLICT"
          ? "内容已被更新，请重新打开最新记录后再修改。"
          : code === "INVALID_PACKAGE"
            ? "参数不完整，不能冻结预览，请补齐所列缺口。"
            : code === "FORBIDDEN"
              ? "当前权限或运行环境不允许此操作。"
              : "操作未完成，请检查输入并重试。";
  } finally {
    busy.value = false;
  }
}
function edit(item: ManagedRecipientType | null) {
  editing.value = item;
  code.value = item?.code ?? "";
  label.value = item?.label ?? "";
  sortOrder.value = String(item?.sortOrder ?? 0);
}
function saveRecipient() {
  void run(async () => {
    await catalogApi.saveRecipient(
      {
        code: code.value,
        label: label.value,
        sortOrder: Number(sortOrder.value),
        active: editing.value?.active ?? true,
      },
      editing.value?.revision ?? null,
      props.csrf,
    );
    edit(null);
    await refresh();
    message.value = "关系已保存。";
  });
}
function toggle(item: ManagedRecipientType) {
  void run(async () => {
    await catalogApi.saveRecipient(
      { ...item, active: !item.active },
      item.revision,
      props.csrf,
    );
    await refresh();
  });
}
function openDraft(draft: PackageDraft | null) {
  selected.value = draft;
  title.value = draft?.title ?? "";
  parameters.value = {
    d01: draft?.d01 ?? {},
    admission: draft?.admission ?? {},
    shippingRegionLabels: draft?.shippingRegionLabels ?? {},
  };
  dirty.value = false;
  error.value = "";
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 131072) throw new Error();
    const parsed: unknown = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) =>
          !["title", "d01", "admission", "shippingRegionLabels"].includes(key),
      ) ||
      typeof value.title !== "string" ||
      !value.d01 ||
      typeof value.d01 !== "object" ||
      Array.isArray(value.d01) ||
      !value.admission ||
      typeof value.admission !== "object" ||
      Array.isArray(value.admission) ||
      (value.shippingRegionLabels !== undefined &&
        (!value.shippingRegionLabels ||
          typeof value.shippingRegionLabels !== "object" ||
          Array.isArray(value.shippingRegionLabels)))
    )
      throw new Error();
    title.value = value.title;
    parameters.value = {
      d01: value.d01 as Record<string, unknown>,
      admission: value.admission as Record<string, unknown>,
      shippingRegionLabels: (value.shippingRegionLabels ?? {}) as Record<
        string,
        string
      >,
    };
    dirty.value = true;
    error.value = "";
    message.value = "参数已载入，保存后校验。";
  } catch {
    error.value =
      "无法导入。请选择符合套餐格式、128 KB 以内的 JSON 文件；不要放入凭据或私人证据正文。";
  } finally {
    input.value = "";
  }
}
function saveDraft() {
  void run(async () => {
    selected.value = await catalogApi.saveDraft(
      { ...parameters.value, title: title.value },
      selected.value,
      props.csrf,
    );
    dirty.value = false;
    await refresh();
    message.value = "草稿已保存。";
  });
}
function freeze() {
  if (!selected.value || dirty.value) return;
  void run(async () => {
    await catalogApi.freeze(selected.value!, props.csrf);
    await refresh();
    message.value = "本地预览版本已冻结，销售仍未开放。";
  });
}
onMounted(() => {
  void run(refresh);
});
</script>
<template>
  <section class="catalog-page">
    <div class="page-title">
      <div>
        <h1>关系与套餐</h1>
        <p>维护赠礼称呼，准备套餐条款与不可变预览。</p>
      </div>
      <Button :loading="busy" @click="run(refresh)">刷新目录</Button>
    </div>
    <Alert
      type="info"
      message="本地预览不代表正式销售授权。首批关系文案与商业参数尚待审核，当前不会开放购买。"
      class="notice"
      show-icon
    />
    <Alert
      v-if="error"
      type="error"
      :message="error"
      role="alert"
      class="notice"
    />
    <Alert
      v-if="message"
      type="success"
      :message="message"
      role="status"
      class="notice"
    />
    <section class="catalog-card">
      <h2>赠礼关系</h2>
      <p>
        代码创建后不变。称呼不推断性别、经历或权限；自定义称呼不进入全局目录。
      </p>
      <Form
        v-if="canWrite"
        layout="vertical"
        class="catalog-form"
        @submit="saveRecipient"
      >
        <FormItem label="关系代码" html-for="recipient-code"
          ><Input
            id="recipient-code"
            v-model:value="code"
            :disabled="!!editing || busy"
            required
            :maxlength="40"
        /></FormItem>
        <FormItem label="公开称呼" html-for="recipient-label"
          ><Input
            id="recipient-label"
            v-model:value="label"
            :disabled="busy"
            required
            :maxlength="40"
        /></FormItem>
        <FormItem label="排序值" html-for="recipient-order"
          ><Input
            id="recipient-order"
            v-model:value="sortOrder"
            type="number"
            min="0"
            max="100000"
            :disabled="busy"
            required
        /></FormItem>
        <div class="catalog-actions">
          <Button html-type="submit" type="primary" :loading="busy">{{
            editing ? "保存关系" : "新增关系"
          }}</Button
          ><Button v-if="editing" :disabled="busy" @click="edit(null)"
            >取消编辑</Button
          >
        </div>
      </Form>
      <div v-if="recipients.length" class="audit-table">
        <table>
          <thead>
            <tr>
              <th>代码</th>
              <th>称呼</th>
              <th>排序</th>
              <th>状态</th>
              <th v-if="canWrite">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in recipients" :key="item.code">
              <td>{{ item.code }}</td>
              <td>{{ item.label }}</td>
              <td>{{ item.sortOrder }}</td>
              <td>{{ item.active ? "启用" : "停用" }}</td>
              <td v-if="canWrite">
                <Button
                  :disabled="busy"
                  :aria-label="`编辑 ${item.code}`"
                  @click="edit(item)"
                  >编辑</Button
                >
                <Button
                  :disabled="busy"
                  :aria-label="`${item.active ? '停用' : '启用'} ${item.code}`"
                  @click="toggle(item)"
                  >{{ item.active ? "停用" : "启用" }}</Button
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else>目录尚为空。未自动添加任何默认关系。</p>
    </section>
    <section class="catalog-card">
      <div class="page-title">
        <div>
          <h2>套餐草稿</h2>
          <p>
            可保留缺参。导入完整套餐 JSON：名称、D01、T05
            准入文件与地区名称；证据仅用受限引用。
          </p>
        </div>
        <Button v-if="canWrite" :disabled="busy" @click="openDraft(null)"
          >新建草稿</Button
        >
      </div>
      <div class="draft-buttons">
        <Button
          v-for="draft in drafts"
          :key="draft.id"
          :disabled="busy"
          :aria-label="`打开草稿 ${draft.title} 修订 ${draft.revision}`"
          @click="openDraft(draft)"
          >{{ draft.title }} · 修订 {{ draft.revision }}</Button
        >
      </div>
      <Form layout="vertical" @submit="saveDraft"
        ><FormItem label="套餐草稿名称" html-for="package-title"
          ><Input
            id="package-title"
            v-model:value="title"
            :disabled="!canWrite || busy"
            required
            :maxlength="100"
            @input="dirty = true"
        /></FormItem>
        <label v-if="canWrite" class="catalog-import"
          >导入套餐参数 JSON<input
            aria-label="导入套餐参数 JSON"
            type="file"
            accept=".json,application/json"
            :disabled="busy"
            @change="importFile"
        /></label>
        <p v-if="selected" class="catalog-validation">
          {{
            selected.validation.completeness === "complete"
              ? "结构完整；审批真实性未核验，销售未开放。"
              : "参数尚未完整，补齐后才能冻结预览。"
          }}
        </p>
        <details v-if="selected?.validation.issues.length">
          <summary>
            查看 {{ selected.validation.issues.length }} 项参数缺口
          </summary>
          <ul class="validation-issues">
            <li
              v-for="(issue, index) in selected.validation.issues"
              :key="index"
            >
              <code>{{ issue.path }}</code
              >：{{ issue.message }}
            </li>
          </ul>
        </details>
        <p v-if="dirty" class="catalog-validation">存在尚未保存的修改。</p>
        <div class="catalog-actions">
          <Button
            v-if="canWrite"
            type="primary"
            html-type="submit"
            :loading="busy"
            >保存草稿</Button
          ><Button
            v-if="canFreeze"
            :disabled="!selected || dirty || busy"
            @click="freeze"
            >冻结本地预览</Button
          >
        </div>
      </Form>
    </section>
    <section class="catalog-card">
      <h2>不可变预览版本</h2>
      <p>冻结后仅追加新版本；草稿修改不会覆盖旧版本。预览仅在本地环境可用。</p>
      <p v-if="!versions.length">尚无预览版本。</p>
      <details
        v-for="version in versions"
        :key="version.id"
        class="version-detail"
      >
        <summary>
          {{ version.title }} · 版本 {{ version.sequence }} · ¥{{
            (version.price.value / 100).toFixed(2)
          }}
        </summary>
        <p>
          一个项目 · 一位成年讲述者 · 一位发起人 · 首本一本 ·
          约定运费及完整导出包含
        </p>
        <dl>
          <template v-for="term in version.terms" :key="term.label"
            ><dt>{{ term.label }}</dt>
            <dd>{{ term.text }}</dd></template
          >
        </dl>
      </details>
    </section>
  </section>
</template>
