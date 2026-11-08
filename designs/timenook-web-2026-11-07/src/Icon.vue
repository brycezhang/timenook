<script setup lang="ts">
import { computed } from "vue";
import icons from "./icons";
const props = withDefaults(defineProps<{ name: string; size?: number }>(), {
  size: 20,
});
const markup = computed(() => icons[props.name] ?? icons["circle-help"]);
</script>
<template>
  <span
    class="icon"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
    v-html="markup"
  ></span>
</template>
