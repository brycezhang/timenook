<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
</script>
<template>
  <svg
    :width="size ?? 20"
    :height="size ?? 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'book'">
      <path
        d="M12 7c-3-2-7-2-10-1v14c3-1 7-1 10 1 3-2 7-2 10-1V6c-3-1-7-1-10 1Z"
      />
      <path d="M12 7v14" />
    </template>
    <template v-else-if="name === 'home'">
      <path d="m3 10 9-7 9 7v10H3Z" />
      <path d="M9 20v-8h6v8" />
    </template>
    <template v-else-if="name === 'user'">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </template>
    <template v-else-if="name === 'arrow'">
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </template>
    <template v-else-if="name === 'lock'">
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="m5 12 4 4 10-10" />
    </template>
    <template v-else-if="name === 'mic'">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8" />
    </template>
    <template v-else-if="name === 'x'">
      <path d="m6 6 12 12M6 18 18 6" />
    </template>
    <template v-else><path d="M5 7h14M5 12h14M5 17h14" /></template>
  </svg>
</template>
