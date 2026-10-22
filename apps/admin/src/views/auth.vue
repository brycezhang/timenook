<script setup lang="ts">
import { ref } from "vue";
import {
  Alert,
  Button,
  Form,
  FormItem,
  Input,
  InputPassword,
} from "antdv-next";
defineProps<{ mfa: boolean; secret: string; busy: boolean; error: string }>();
const emit = defineEmits<{
  login: [username: string, password: string];
  verify: [code: string];
  cancel: [];
}>();
const username = ref(""),
  password = ref(""),
  code = ref("");
function login() {
  emit("login", username.value, password.value);
  password.value = "";
}
function verify() {
  emit("verify", code.value);
  code.value = "";
}
</script>
<template>
  <main class="auth-page">
    <section class="auth-panel">
      <div class="brand">时光里 <span>运营管理</span></div>
      <h1>{{ mfa ? "双重验证" : "运营登录" }}</h1>
      <p class="description">
        {{
          mfa
            ? "请输入身份验证器中的六位验证码。"
            : "使用独立管理员账号访问运营入口。"
        }}
      </p>
      <Alert
        v-if="error"
        type="error"
        :message="error"
        show-icon
        class="notice"
        role="alert"
      />
      <Form v-if="!mfa" layout="vertical" @submit="login">
        <FormItem label="管理员账号" html-for="username"
          ><Input
            id="username"
            v-model:value="username"
            autocomplete="username"
            :maxlength="64"
            required
        /></FormItem>
        <FormItem label="密码" html-for="password"
          ><InputPassword
            id="password"
            v-model:value="password"
            autocomplete="current-password"
            :maxlength="128"
            required
        /></FormItem>
        <Button
          type="primary"
          html-type="submit"
          block
          size="large"
          :loading="busy"
          >继续验证</Button
        >
      </Form>
      <Form v-else layout="vertical" @submit="verify">
        <div v-if="secret" class="enrollment">
          <strong>首次设置身份验证器</strong>
          <p>
            在身份验证器中添加 TimeNook 账号，使用以下设置密钥。请勿截图或分享。
          </p>
          <code data-testid="enrollment-secret">{{ secret }}</code>
        </div>
        <FormItem label="六位验证码" html-for="code"
          ><Input
            id="code"
            v-model:value="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]{6}"
            :maxlength="6"
            required
        /></FormItem>
        <Button
          type="primary"
          html-type="submit"
          block
          size="large"
          :loading="busy"
          >验证并登录</Button
        >
        <Button block class="cancel" :disabled="busy" @click="emit('cancel')"
          >返回登录</Button
        >
      </Form>
    </section>
  </main>
</template>
