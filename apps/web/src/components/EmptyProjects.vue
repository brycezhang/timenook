<script setup lang="ts">
import { RouterLink } from "vue-router";
import Icon from "./Icon.vue";
defineProps<{ title?: string }>();
</script>
<template>
  <section class="empty-state panel workspace-empty">
    <span class="empty-icon"><Icon name="book" :size="30" /></span>
    <h2>{{ title ?? "第一本故事书，从这里开始。" }}</h2>
    <RouterLink class="button" to="/purchase"
      ><Icon name="plus" :size="17" />开始一本故事书</RouterLink
    >
    <RouterLink class="text-button" to="/sample"
      >先翻翻样书<Icon name="arrow" :size="16"
    /></RouterLink>
  </section>
</template>
