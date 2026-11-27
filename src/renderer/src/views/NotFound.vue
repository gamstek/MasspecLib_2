<!-- src/renderer/views/NotFound.vue -->
<template>
  <div class="not-found">
    <div class="content">
      <!-- 大大的 404 -->
      <h1 class="code">404</h1>
      <!-- 文字说明 -->
      <p class="title">页面走丢了～</p>
      <p class="desc">你访问的页面不存在，可能被外星人绑架了</p>

      <!-- 操作按钮 -->
      <div class="actions">
        <el-button type="primary" size="large" @click="goBack"> 返回上一页 </el-button>
        <el-button size="large" style="margin-left: 16px" @click="goHome"> 回到首页 </el-button>
      </div>

      <!-- 可爱的动画小人（纯 CSS） -->
      <div class="astronaut">
        <div class="helmet"></div>
        <div class="body"></div>
        <div class="arm-left"></div>
        <div class="arm-right"></div>
        <div class="leg-left"></div>
        <div class="leg-right"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

const goBack = () => {
  router.back()
}

const goHome = () => {
  router.push('/')
}
</script>

<style lang="less" scoped>
.not-found {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  overflow: hidden;
  position: relative;
}

.content {
  text-align: center;
  color: #fff;
  z-index: 2;
  animation: fadeInUp 0.8s ease-out;
}

.code {
  font-size: 120px;
  font-weight: 900;
  margin: 0;
  line-height: 1;
  text-shadow: 0 10px 20px rgba(0, 0, 0, 0.3);
  animation: bounce 2s infinite;
}

.title {
  font-size: 36px;
  margin: 20px 0 10px;
  font-weight: 600;
}

.desc {
  font-size: 18px;
  opacity: 0.9;
  margin-bottom: 40px;
}

.actions {
  .el-button {
    border-radius: 50px;
    padding: 12px 32px;
    font-size: 16px;
  }
}

/* 小宇航员动画 */
.astronaut {
  position: absolute;
  bottom: 10%;
  right: 10%;
  width: 120px;
  height: 160px;
  animation: float 6s ease-in-out infinite;
}

.helmet {
  width: 60px;
  height: 60px;
  background: #fff;
  border-radius: 50%;
  position: absolute;
  top: 0;
  left: 30px;
  box-shadow: inset -10px -10px 20px rgba(0,0,0,0.2);
}

.body {
  width: 80px;
  height: 80px;
  background: #fff;
  border-radius: 20px;
  position: absolute;
  top: 50px;
  left: 20px;
}

.arm-left, .arm-right {
  width: 30px;
  height: 60px;
  background: #fff;
  border-radius: 15px;
  position: absolute;
  top: 70px;
}

.arm-left  { left: 10px; transform: rotate(30deg); }
.arm-right { right: 10px; transform: rotate(-30deg); }

.leg-left, .leg-right {
  width: 30px;
  height: 50px;
  background: #fff;
  border-radius: 15px;
  position: absolute;
  bottom: 0;
}

.leg-left  { left: 25px; }
.leg-right { right: 25px; }

/* 动画关键帧 */
@keyframes bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-20px); }
}

@keyframes float {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-30px) rotate(5deg); }
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(50px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>