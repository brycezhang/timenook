<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { webApi } from "../api";
import { auth } from "../session";
import Icon from "./Icon.vue";
const emit = defineEmits<{ close: []; success: [] }>();
const dialog = ref<HTMLDialogElement>();
const phone = ref("");
const code = ref("");
const agreed = ref(false);
const challenge = ref("");
const sentPhone = ref("");
const remaining = ref(0);
const sending = ref(false);
const submitting = ref(false);
const error = ref("");
let active = true;
let deadline = 0;
const timer = window.setInterval(() => {
  remaining.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}, 250);
onMounted(async () => {
  dialog.value?.showModal();
  await nextTick();
  dialog.value?.querySelector<HTMLInputElement>("input")?.focus();
});
onUnmounted(() => {
  active = false;
  clearInterval(timer);
});
function close() {
  if (!submitting.value) emit("close");
}
async function send() {
  error.value = "";
  if (!/^1[3-9]\d{9}$/.test(phone.value)) {
    error.value = "请输入正确的 11 位手机号。";
    return;
  }
  if (!agreed.value) {
    error.value = "请先阅读并同意使用条款。";
    return;
  }
  sending.value = true;
  try {
    const number = phone.value;
    const result = await webApi.sendCode(number);
    if (!active) return;
    challenge.value = result.challengeId;
    sentPhone.value = number;
    deadline = Date.now() + result.retryAfterSeconds * 1000;
    remaining.value = result.retryAfterSeconds;
    await nextTick();
    dialog.value?.querySelector<HTMLInputElement>("#sms-code")?.focus();
  } catch (reason) {
    if (active)
      error.value =
        reason instanceof Error ? reason.message : "验证码发送失败，请重试。";
  } finally {
    sending.value = false;
  }
}
async function submit() {
  error.value = "";
  if (!agreed.value) {
    error.value = "请先阅读并同意使用条款。";
    return;
  }
  if (!challenge.value || phone.value !== sentPhone.value) {
    error.value = "请先为当前手机号获取验证码。";
    return;
  }
  if (!/^\d{6}$/.test(code.value)) {
    error.value = "请输入 6 位验证码。";
    return;
  }
  submitting.value = true;
  try {
    await auth.login(challenge.value, code.value);
    if (active) emit("success");
  } catch (reason) {
    if (active)
      error.value =
        reason instanceof Error ? reason.message : "登录失败，请重试。";
  } finally {
    submitting.value = false;
  }
}
</script>
<template>
  <dialog
    ref="dialog"
    class="login-dialog"
    aria-labelledby="login-title"
    @cancel.prevent="close"
    @click="$event.target === dialog && close()"
  >
    <form class="login-form" @submit.prevent="submit">
      <button
        class="icon-button close-dialog"
        type="button"
        aria-label="关闭登录"
        :disabled="submitting"
        @click="close"
      >
        <Icon name="x" />
      </button>
      <div class="login-mark"><Icon name="book" :size="28" /></div>
      <h2 id="login-title">登录，继续你的故事</h2>
      <label for="phone">手机号</label>
      <div class="phone-input">
        <span>+86</span
        ><input
          id="phone"
          v-model="phone"
          type="tel"
          inputmode="numeric"
          autocomplete="tel-national"
          maxlength="11"
          placeholder="请输入手机号"
          :disabled="sending || submitting"
          required
        />
      </div>
      <label for="sms-code">短信验证码</label>
      <div class="code-input">
        <input
          id="sms-code"
          v-model="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]{6}"
          maxlength="6"
          placeholder="6 位验证码"
          :disabled="submitting"
          required
        /><button
          type="button"
          class="text-button send-code"
          :disabled="sending || submitting || remaining > 0"
          @click="send"
        >
          <span v-if="sending" class="spinner" />{{
            sending
              ? "发送中"
              : remaining > 0
                ? `${remaining}秒后重发`
                : "获取验证码"
          }}
        </button>
      </div>
      <label class="agreement"
        ><input v-model="agreed" type="checkbox" :disabled="submitting" /><span
          >我已阅读并同意
          <RouterLink to="/terms" target="_blank"
            >《使用条款与隐私说明》</RouterLink
          ></span
        ></label
      >
      <p v-if="challenge && !error" class="success-note" role="status">
        验证码已发送，5 分钟内有效。
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button
        class="button full-width"
        type="submit"
        :disabled="submitting || sending"
      >
        <span v-if="submitting" class="spinner" />{{
          submitting ? "正在登录" : "登录并继续"
        }}<Icon v-if="!submitting" name="arrow" :size="17" />
      </button>
    </form>
  </dialog>
</template>
