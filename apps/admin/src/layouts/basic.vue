<script setup lang="ts">
import { VbenAdminLayout } from "@vben-core/layout-ui";
import { useMediaQuery } from "@vueuse/core";
import OperatorHeader from "./operator-header.vue";
defineProps<{ username: string; busy: boolean }>();
const emit = defineEmits<{ logout: [] }>();
const mobile = useMediaQuery("(max-width: 767px)");
</script>
<template>
  <VbenAdminLayout
    :key="mobile ? 'mobile' : 'desktop'"
    :header-mode="mobile ? 'static' : 'fixed'"
    :is-mobile="mobile"
    :header-visible="!mobile"
    :sidebar-hidden="mobile"
    :sidebar-width="220"
    :sidebar-draggable="false"
    :sidebar-enable="!mobile"
    :sidebar-collapsed-button="false"
    :sidebar-fixed-button="false"
    :tabbar-enable="false"
    :header-toggle-sidebar-button="false"
    :content-padding-left="mobile ? 20 : 36"
    :content-padding-right="mobile ? 20 : 36"
    :content-padding-top="mobile ? 24 : 36"
    :content-padding-bottom="36"
    :header-height="68"
  >
    <template v-if="!mobile" #logo
      ><div class="sidebar-brand">时光里</div></template
    >
    <template #menu><div class="sidebar-menu">运营入口</div></template>
    <template #header
      ><OperatorHeader
        :username="username"
        :busy="busy"
        @logout="emit('logout')"
    /></template>
    <template #content>
      <OperatorHeader
        v-if="mobile"
        :username="username"
        :busy="busy"
        @logout="emit('logout')"
      />
      <slot />
    </template>
  </VbenAdminLayout>
</template>
