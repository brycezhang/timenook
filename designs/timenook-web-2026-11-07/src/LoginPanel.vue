<script setup lang="ts">
import Icon from "./Icon.vue";
defineProps<{ accepted: boolean; busy: boolean; error: string }>();
defineEmits<{
  "update:accepted": [value: boolean];
  submit: [];
  terms: [];
  cancel: [];
}>();
</script>
<template>
  <div class="login-emblem"><Icon name="book-open" :size="30" /></div>
  <p class="modal-description">
    让每一次讲述，都有处安放。<br />登录后查看已有项目，或开始你的第一本故事书。
  </p>
  <div class="login-benefits">
    <span><Icon name="lock-keyhole" :size="17" />私密保存</span
    ><span><Icon name="users-round" :size="17" />家人共创</span
    ><span><Icon name="book-open" :size="17" />随时继续</span>
  </div>
  <form @submit.prevent="$emit('submit')">
    <div class="login-agreement">
      <input
        id="login-agreement"
        type="checkbox"
        :checked="accepted"
        :disabled="busy"
        @change="
          $emit('update:accepted', ($event.target as HTMLInputElement).checked)
        "
      /><label for="login-agreement">我已阅读并同意</label
      ><button type="button" :disabled="busy" @click="$emit('terms')">
        《使用条款》
      </button>
    </div>
    <p v-if="error" class="login-error" role="alert">
      <Icon name="circle-help" :size="18" />{{ error }}
    </p>
    <button
      class="button full-width"
      type="submit"
      :disabled="!accepted || busy"
    >
      <Icon
        :name="busy ? 'loader-circle' : 'arrow-right'"
        :class="{ spin: busy }"
        :size="18"
      />{{ busy ? "正在登录…" : error ? "重新登录" : "登录并继续" }}
    </button>
    <button
      class="text-button login-cancel"
      type="button"
      @click="$emit('cancel')"
    >
      暂不登录，继续看看
    </button>
  </form>
  <p class="login-demo-note">设计预览使用示例账号，不进行真实登录或付款。</p>
</template>
