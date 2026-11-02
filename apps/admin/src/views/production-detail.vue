<script setup lang="ts">
import { useRoute } from "vue-router";
import { Page } from "@vben/common-ui";
import { Button, Card } from "antdv-next";
import { safeReturn } from "../router";
import { expireSession, session } from "../session";
import Fulfillment from "./fulfillment.vue";
const route = useRoute();
</script>
<template>
  <Page title="生产单详情"
    ><template #title><h1>生产单详情</h1></template>
    <Card
      ><RouterLink
        :to="route.query.from ? safeReturn(route.query.from) : '/production'"
        ><Button>返回查询位置</Button></RouterLink
      >
      <Fulfillment
        :key="String(route.params.id)"
        :csrf="session?.csrfToken ?? ''"
        :initial-order-id="String(route.params.id)"
        :return-path="route.fullPath"
        @expired="expireSession"
      />
    </Card>
  </Page>
</template>
