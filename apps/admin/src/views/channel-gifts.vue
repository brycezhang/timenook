<script setup lang="ts">
import { Page } from "@vben/common-ui";
import ChannelGifts from "../components/channel-gifts.vue";
</script>
<template>
  <Page description="录入第三方渠道购买，查看和处理渠道购买记录。">
    <template #title><h1>录入订单</h1></template>
    <ChannelGifts />
  </Page>
</template>
