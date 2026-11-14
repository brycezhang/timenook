<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { Page } from "@vben/common-ui";
import { Button, Card } from "antdv-next";
import { safeReturn } from "../router";
import { expireSession, session } from "../session";
import Fulfillment from "./fulfillment.vue";
const route = useRoute();
const back = computed(() =>
  typeof route.query.from === "string"
    ? safeReturn(route.query.from)
    : "/production",
);
</script>
<template>
  <Page title="生产单详情" header-class="flex-wrap gap-2"
    ><template #title><h1>生产单详情</h1></template>
    <template #extra>
      <RouterLink :to="back" custom v-slot="{ href, navigate }">
        <Button :href="href" @click="navigate">返回查询位置</Button>
      </RouterLink>
    </template>
    <Card>
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
