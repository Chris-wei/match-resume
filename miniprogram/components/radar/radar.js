// 雷达图组件：canvas 2d 自绘五维图，无第三方依赖。
// 用法：<radar data="{{[{label:'技能', value:80, count:5}, ...]}}" />
Component({
  properties: {
    // [{label, value(0-100), count}]，count 为 0 时该维度淡显
    data: {
      type: Array,
      value: []
    },
    // 画布边长（rpx），默认 440
    size: {
      type: Number,
      value: 440
    }
  },
  observers: {
    data() {
      this.draw()
    }
  },
  lifetimes: {
    ready() {
      this.draw()
    }
  },
  methods: {
    draw() {
      const items = this.data.data || []
      const key = JSON.stringify(items)
      // 初始化时 observers 与 ready 会先后各触发一次；数据没变且已画过、
      // 或上一次绘制还没完成时直接跳过——重复重设画布尺寸会导致滚动抖动
      if (this._pending || (this._sized && this._lastKey === key)) return
      this._pending = true
      this._lastKey = key

      this.createSelectorQuery()
        .select('#radar')
        .fields({ node: true, size: true })
        .exec((res) => {
          this._pending = false
          if (!res || !res[0] || !res[0].node) return
          const canvas = res[0].node
          const w = res[0].width
          const h = res[0].height
          // 布局未稳定时尺寸可能为 0：直接画会得到错位内容，等一拍重试
          if (!w || !h) {
            if ((this._retries || 0) < 5) {
              this._retries = (this._retries || 0) + 1
              this._lastKey = undefined
              setTimeout(() => this.draw(), 120)
            }
            return
          }
          this._retries = 0
          const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
          const dpr = (info && info.pixelRatio) || 2

          // 尺寸没变就不重设：重设会清空画布状态，是闪烁的根源
          if (canvas.width !== Math.round(w * dpr)) {
            canvas.width = Math.round(w * dpr)
            canvas.height = Math.round(h * dpr)
          }
          this._sized = true

          const ctx = canvas.getContext('2d')
          // setTransform 幂等；不能用 scale 累加（重复绘制会越画越大）
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          ctx.clearRect(0, 0, w, h)

          const cx = w / 2
          const cy = h / 2
          const R = Math.min(w, h) / 2 - 34
          const N = Math.max(3, Math.min(items.length, 8)) // 至少画三边形，最多八边形
          const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / N
          const point = (i, r) => ({ x: cx + r * Math.cos(angle(i)), y: cy + r * Math.sin(angle(i)) })

          // 网格环
          ctx.strokeStyle = '#eceef3'
          ctx.lineWidth = 1
          for (let level = 1; level <= 4; level++) {
            ctx.beginPath()
            for (let i = 0; i < N; i++) {
              const p = point(i, (R * level) / 4)
              if (i === 0) ctx.moveTo(p.x, p.y)
              else ctx.lineTo(p.x, p.y)
            }
            ctx.closePath()
            ctx.stroke()
          }
          // 轴线
          for (let i = 0; i < N; i++) {
            const p = point(i, R)
            ctx.beginPath()
            ctx.moveTo(cx, cy)
            ctx.lineTo(p.x, p.y)
            ctx.stroke()
          }

          if (items.length > 0) {
            // 数据多边形
            ctx.beginPath()
            for (let i = 0; i < N; i++) {
              const v = Math.max(0, Math.min(100, items[i] ? items[i].value : 0))
              const p = point(i, (R * v) / 100)
              if (i === 0) ctx.moveTo(p.x, p.y)
              else ctx.lineTo(p.x, p.y)
            }
            ctx.closePath()
            ctx.fillStyle = 'rgba(59, 91, 253, 0.16)'
            ctx.fill()
            ctx.strokeStyle = '#3b5bfd'
            ctx.lineWidth = 2
            ctx.stroke()
            // 顶点
            for (let i = 0; i < N; i++) {
              const v = Math.max(0, Math.min(100, items[i] ? items[i].value : 0))
              const p = point(i, (R * v) / 100)
              ctx.beginPath()
              ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
              ctx.fillStyle = '#3b5bfd'
              ctx.fill()
            }
          }

          // 标签
          ctx.font = '12px -apple-system, "PingFang SC", sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          for (let i = 0; i < N; i++) {
            const item = items[i] || { label: '' }
            const p = point(i, R + 18)
            ctx.fillStyle = item.count === 0 ? '#c9cdd4' : '#4b5563'
            ctx.fillText(item.label || '', p.x, p.y)
          }
        })
    }
  }
})
