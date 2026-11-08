<script setup lang="ts">
import { useRoute } from "vue-router";
import Photos from "./Photos.vue";
const route = useRoute();
</script>
<template><Photos :story-id="String(route.params.storyId)" /></template>
