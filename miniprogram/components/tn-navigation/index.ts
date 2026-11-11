Component({
  properties: {
    title: { type: String, value: "" },
    brand: { type: Boolean, value: false },
    back: { type: Boolean, value: true },
    interceptBack: { type: Boolean, value: false },
  },
  data: { statusHeight: 20, rightInset: 100, compact: false },
  lifetimes: {
    attached() {
      const window = wx.getWindowInfo();
      const capsule = wx.getMenuButtonBoundingClientRect();
      this.setData({
        statusHeight: window.statusBarHeight,
        compact: window.windowWidth <= 350,
        rightInset: window.windowWidth - capsule.left + 8,
      });
    },
  },
  methods: {
    goBack() {
      if (this.properties.interceptBack) {
        this.triggerEvent("back");
        return;
      }
      if (getCurrentPages().length > 1) wx.navigateBack();
      else wx.switchTab({ url: "/pages/home/index" });
    },
  },
});
