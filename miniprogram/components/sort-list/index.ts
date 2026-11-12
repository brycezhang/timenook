type Row = {
  id: string;
  title: string;
  subtitle?: string;
  image?: string;
  imageLoading?: boolean;
};
Component({
  properties: {
    items: { type: Array, value: [] as Row[] },
    numbered: Boolean,
    modern: Boolean,
    compact: Boolean,
    actionLabel: String,
    editable: Boolean,
    disabled: Boolean,
  },
  data: {
    rows: [] as Row[],
    dragging: "",
    lastDragY: null as number | null,
    queryVersion: 0,
  },
  observers: {
    items(items: Row[]) {
      if (!this.data.dragging) this.setData({ rows: items });
    },
  },
  methods: {
    input(e: WechatMiniprogram.Input) {
      this.triggerEvent("caption", {
        id: e.currentTarget.dataset.id,
        value: e.detail.value,
      });
    },
    open(e: WechatMiniprogram.TouchEvent) {
      if (!this.data.dragging && !this.data.disabled)
        this.triggerEvent("open", { id: e.currentTarget.dataset.id });
    },
    action(e: WechatMiniprogram.TouchEvent) {
      if (!this.data.disabled)
        this.triggerEvent("action", { id: e.currentTarget.dataset.id });
    },
    start(e: WechatMiniprogram.TouchEvent) {
      if (this.data.disabled) return;
      ++this.data.queryVersion;
      this.data.lastDragY = null;
      this.setData({ dragging: e.currentTarget.dataset.id as string });
      wx.vibrateShort?.({ type: "light" });
    },
    placeAt(y: number, done?: () => void) {
      const id = this.data.dragging,
        version = ++this.data.queryVersion;
      this.createSelectorQuery()
        .selectAll(".sort-row")
        .boundingClientRect((rects) => {
          if (this.data.dragging !== id || version !== this.data.queryVersion)
            return;
          if (Array.isArray(rects)) {
            const rows = [...this.data.rows];
            const from = rows.findIndex((r) => r.id === id);
            const to = rects.findIndex((r) => y >= r.top && y <= r.bottom);
            if (to >= 0 && from >= 0 && to !== from) {
              rows.splice(to, 0, rows.splice(from, 1)[0]);
              this.setData({ rows });
            }
          }
          done?.();
        })
        .exec();
    },
    move(e: WechatMiniprogram.TouchEvent) {
      const id = this.data.dragging,
        y = e.touches[0]?.clientY;
      if (!id || y === undefined) return;
      this.data.lastDragY = y;
      this.placeAt(y);
      const version = this.data.queryVersion;
      const height = wx.getSystemInfoSync().windowHeight;
      if (y < 100 || y > height - 110)
        this.createSelectorQuery()
          .selectViewport()
          .scrollOffset((offset) => {
            if (
              !Array.isArray(offset) &&
              this.data.dragging === id &&
              version === this.data.queryVersion
            )
              wx.pageScrollTo({
                scrollTop: Math.max(0, offset.scrollTop + (y < 100 ? -24 : 24)),
                duration: 0,
              });
          })
          .exec();
    },
    end(e?: WechatMiniprogram.TouchEvent) {
      if (!this.data.dragging) return;
      const done = () => {
        this.setData({ dragging: "" });
        if (
          this.data.rows.some(
            (r, i) => r.id !== (this.data.items[i] as Row)?.id,
          )
        )
          this.triggerEvent("reorder", {
            ids: this.data.rows.map((r) => r.id),
          });
      };
      const y = e?.changedTouches?.[0]?.clientY ?? this.data.lastDragY;
      if (y === null) done();
      else this.placeAt(y, done);
    },
    cancel() {
      ++this.data.queryVersion;
      this.setData({ dragging: "", rows: this.data.items as Row[] });
    },
  },
});
