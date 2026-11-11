Page({
  data: { status: "" },
  privacy() {
    wx.openPrivacyContract({
      fail: () =>
        this.setData({ status: "隐私保护指引暂时无法打开，请稍后重试" }),
    });
  },
  back() {
    wx.navigateBack();
  },
});
