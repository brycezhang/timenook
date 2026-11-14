<script setup lang="ts">
import { AuthPageLayout } from "@vben/layouts";
import { adminName } from "../preferences";
</script>
<template>
  <AuthPageLayout
    :app-name="adminName"
    :toolbar="false"
    :copyright="false"
  />
</template>
