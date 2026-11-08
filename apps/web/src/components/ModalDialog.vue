<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from "vue";
import Icon from "./Icon.vue";
const props = defineProps<{
  title: string;
  busy?: boolean;
  closeLabel?: string;
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const titleId = useId();
function close() {
  if (props.busy) return;
  dialog.value?.close();
  emit("close");
}
function trapTab(event: KeyboardEvent) {
  if (event.key !== "Tab" || !dialog.value) return;
  const controls = [
    ...dialog.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.getClientRects().length > 0);
  if (!controls.length) return;
  event.preventDefault();
  const index = controls.indexOf(document.activeElement as HTMLElement);
  controls[
    (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
  ]?.focus();
}
onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => dialog.value?.close());
</script>
<template>
  <dialog
    ref="dialog"
    class="edit-dialog"
    :aria-labelledby="titleId"
    @cancel.prevent="close"
    @keydown="trapTab"
    @click="$event.target === dialog && close()"
  >
    <div class="edit-dialog-body">
      <button
        class="icon-button close-dialog"
        type="button"
        :aria-label="closeLabel ?? `关闭${title}`"
        :disabled="busy"
        @click="close"
      >
        <Icon name="x" />
      </button>
      <h2 :id="titleId">{{ title }}</h2>
      <slot :close="close" />
    </div>
  </dialog>
</template>
