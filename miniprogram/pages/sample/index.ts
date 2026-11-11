import { sessionClient } from "../../services/session";
import { go } from "../../services/store";
Page({
  data: { loginVisible: false },
  purchase() {
    if (sessionClient.context()) go("new-book");
    else this.setData({ loginVisible: true });
  },
  loginSucceeded() {
    this.setData({ loginVisible: false });
    go("new-book");
  },
  closeLogin() {
    this.setData({ loginVisible: false });
  },
});
