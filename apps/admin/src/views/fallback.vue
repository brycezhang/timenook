<script setup lang="ts">
import { Page } from "@vben/common-ui";
import { Result, Button } from "antdv-next";
import { useRoute, useRouter } from "vue-router";
import { businessMenus } from "../router";
import { can } from "../session";
const route = useRoute(),
  router = useRouter();
</script>
<template>
  <Page
    ><Result
      :status="route.meta.status === '403' ? '403' : '404'"
      :title="String(route.meta.title)"
      :sub-title="
        route.meta.status === '403'
          ? '当前管理员没有此页面权限。'
          : '请检查链接或从左侧菜单进入。'
      "
      ><template #extra
        ><Button
          v-for="menu in businessMenus.filter((m) => can(m.permission))"
          :key="menu.path"
          @click="router.push(menu.path)"
          >{{ menu.name }}</Button
        ></template
      ></Result
    ></Page
  >
</template>
