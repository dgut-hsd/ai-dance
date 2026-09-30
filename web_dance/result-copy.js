const RESULT_COPY = {
  S: { title: "这把封神", tagline: "高光不是偶然" },
  A: { title: "全场焦点", tagline: "状态已经拉满" },
  B: { title: "舞感在线", tagline: "这一拍很有感觉" },
  C: { title: "越跳越上头", tagline: "节奏正在接管身体" },
  D: { title: "敢跳就很酷", tagline: "下一把继续上头" },
};

export function resultCopyFor(grade) {
  return RESULT_COPY[grade] || RESULT_COPY.D;
}
