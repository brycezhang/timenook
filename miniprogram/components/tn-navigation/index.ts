Component({
  properties: {
    title: { type: String, value: "" },
    brand: { type: Boolean, value: false },
    back: { type: Boolean, value: true },
  },
  data: { statusHeight: 20, rightInset: 100 },
  lifetimes: {
    attached() {
      const window = wx.getWindowInfo();
      const capsule = wx.getMenuButtonBoundingClientRect();
      this.setData({
        statusHeight: window.statusBarHeight,
        rightInset: window.windowWidth - capsule.left + 8,
      });
    },
  },
  methods: {
    goBack() {
      if (getCurrentPages().length > 1) wx.navigateBack();
      else wx.switchTab({ url: "/pages/home/index" });
    },
  },
});
