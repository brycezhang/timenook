<script lang="ts" setup>
import type { ThemeModeType } from '@vben/types';

import { MoonStar, Sun, SunMoon } from '@vben/icons';
import { $t } from '@vben/locales';
import {
  preferences,
  updatePreferences,
  usePreferences,
} from '@vben/preferences';

import {
  ToggleGroup,
  ToggleGroupItem,
  VbenButton,
  VbenPopover,
} from '@vben-core/shadcn-ui';

defineOptions({
  name: 'ThemeToggle',
});

const { isDark } = usePreferences();

const PRESETS = [
  {
    icon: Sun,
    name: 'light',
    title: $t('preferences.theme.light'),
  },
  {
    icon: MoonStar,
    name: 'dark',
    title: $t('preferences.theme.dark'),
  },
  {
    icon: SunMoon,
    name: 'auto',
    title: $t('preferences.followSystem'),
  },
];
</script>
<template>
  <div>
    <VbenPopover>
      <template #trigger>
        <VbenButton
          class="rounded-full cursor-pointer"
          size="icon"
          :style="{ padding: '7px' }"
          variant="icon"
        >
          <Sun v-if="!isDark" class="size-5" />
          <MoonStar v-else class="size-5" />
        </VbenButton>
      </template>
      <ToggleGroup
        :model-value="preferences.theme.mode"
        class="gap-2"
        type="single"
        variant="outline"
        @update:model-value="
          (val) => updatePreferences({ theme: { mode: val as ThemeModeType } })
        "
      >
        <ToggleGroupItem
          v-for="item in PRESETS"
          :key="item.name"
          :value="item.name"
          :title="item.title"
        >
          <component :is="item.icon" class="size-5" />
        </ToggleGroupItem>
      </ToggleGroup>
    </VbenPopover>
  </div>
</template>
