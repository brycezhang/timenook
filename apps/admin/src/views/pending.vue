<script setup lang="ts">
import { Page } from "@vben/common-ui";
import { Result, Button } from "antdv-next";
import { useRoute, useRouter } from "vue-router";
const route = useRoute(),
  router = useRouter();
</script>
<template>
  <Page :title="String(route.meta.title)"
    ><Result
      status="info"
      title="此功能待交付"
      sub-title="用户服务与生产操作暂未开放。"
      ><template #extra
        ><Button @click="router.back()">返回上一页</Button></template
      ></Result
    ></Page
  >
</template>
