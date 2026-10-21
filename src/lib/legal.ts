/**
 * The terms of use and the personal-data notice, in both languages.
 *
 * Kept as data rather than one t() key per paragraph: these are documents a person reads end to
 * end, and they change as a whole when the centre's lawyer edits them. The pages pick the
 * language with useLang().
 *
 * DRAFT: written from what the app actually collects and does (SRS v2.3: UC-02, UC-05, BR-03,
 * BR-04, BR-05, BR-24, NFR-19 to NFR-25) and from Decree 13/2023/ND-CP. The centre has to review
 * it before it is final; until then the pages say so. Limits the manager can change (how long a
 * hold lasts, courts per day, cancellation windows) are described as "shown in the app" rather
 * than written in, so the text cannot drift from the settings.
 */

export type LegalSection = { heading: string; body: string[] };
export type LegalDoc = { title: string; intro: string; sections: LegalSection[] };

/** Flip once the centre has approved the text. */
export const LEGAL_DRAFT = true;
export const LEGAL_UPDATED = "2026-10-15";

export const PRIVACY: Record<"en" | "vi", LegalDoc> = {
  en: {
    title: "Personal data notice",
    intro:
      "How Lê Long Sport Center collects and uses your personal data when you use the app and the centre, under Decree 13/2023/ND-CP on personal data protection. You agree to it when you create an account; you can withdraw that consent at any time.",
    sections: [
      {
        heading: "What we collect",
        body: [
          "When you sign up: your full name, phone number, email address and date of birth. For a member under 16, also a guardian's name and phone number.",
          "As you use the centre: your court bookings, class enrolments and attendance, gate check-ins, payments and receipts, loyalty points, support requests and messages to the assistant.",
          "Only if you give them: health notes for your coach, and a tax code for an e-invoice.",
        ],
      },
      {
        heading: "Why we use it",
        body: [
          "To run your bookings, classes and membership; to take payments and issue the receipts and invoices the law requires; to send you codes, confirmations and reminders; and to keep the centre safe.",
          "We do not sell your data and we do not use it for advertising.",
        ],
      },
      {
        heading: "Who sees it",
        body: [
          "You. Front desk staff and the manager, to serve you. Coaches see the students in their own classes, and health notes only where they need them.",
          "Service providers that work for us: payOS for online payments, our email provider for codes and notices, and our hosting and database providers. The assistant's AI provider receives the centre's schedules and prices, never your personal data.",
          "Public authorities, only when the law requires it.",
        ],
      },
      {
        heading: "How long we keep it",
        body: [
          "While your account is open. Payments, receipts and invoices are kept as long as accounting and tax law requires (currently at least 10 years).",
          "When you close your account, the rest is deleted or made anonymous, unless the law requires us to keep it.",
        ],
      },
      {
        heading: "Your rights",
        body: [
          "You can see and correct your details in Account, ask for a copy of your data, withdraw your consent, ask us to delete or stop using your data, and complain if you think we got something wrong.",
          "Withdrawing consent or deleting your data means we can no longer run bookings or a membership for you. Ask at the front desk or send a support request in the app.",
        ],
      },
      {
        heading: "Children",
        body: [
          "A member under 16 needs a guardian. The guardian's name and phone number are kept with the account, and the guardian gives the consent on the child's behalf.",
        ],
      },
      {
        heading: "Security",
        body: [
          "Passwords are stored only as secure hashes. Member sessions end after seven days and staff sessions after twelve hours. Every request is checked on the server, and a member can read only their own bookings, receipts and profile.",
          "The app keeps your sign-in and your preferences (language, how many rows a list shows) in your browser. There are no advertising trackers.",
        ],
      },
      {
        heading: "Contact",
        body: ["Questions about your data: ask at the front desk, or send a support request from Account in the app."],
      },
    ],
  },
  vi: {
    title: "Thông báo về dữ liệu cá nhân",
    intro:
      "Cách Lê Long Sport Center thu thập và sử dụng dữ liệu cá nhân của bạn khi bạn dùng app và đến trung tâm, theo Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân. Bạn đồng ý với thông báo này khi tạo tài khoản, và có thể rút lại sự đồng ý bất cứ lúc nào.",
    sections: [
      {
        heading: "Chúng tôi thu thập gì",
        body: [
          "Khi đăng ký: họ tên, số điện thoại, email và ngày sinh. Với hội viên dưới 16 tuổi, thêm họ tên và số điện thoại của người giám hộ.",
          "Khi bạn dùng dịch vụ: các lượt đặt sân, đăng ký lớp và điểm danh, lượt vào cổng, thanh toán và biên lai, điểm thưởng, yêu cầu hỗ trợ và tin nhắn gửi trợ lý.",
          "Chỉ khi bạn cung cấp: ghi chú sức khoẻ cho huấn luyện viên, và mã số thuế để xuất hoá đơn điện tử.",
        ],
      },
      {
        heading: "Chúng tôi dùng để làm gì",
        body: [
          "Để vận hành việc đặt sân, lớp học và gói tập; nhận thanh toán và xuất biên lai, hoá đơn theo quy định; gửi mã xác minh, xác nhận và lời nhắc; và giữ an toàn tại trung tâm.",
          "Chúng tôi không bán dữ liệu của bạn và không dùng dữ liệu cho quảng cáo.",
        ],
      },
      {
        heading: "Ai được xem",
        body: [
          "Bạn. Lễ tân và quản lý, để phục vụ bạn. Huấn luyện viên xem học viên trong lớp của mình, và chỉ xem ghi chú sức khoẻ khi cần.",
          "Các nhà cung cấp dịch vụ làm việc cho chúng tôi: payOS cho thanh toán online, nhà cung cấp email để gửi mã và thông báo, cùng nhà cung cấp máy chủ và cơ sở dữ liệu. Nhà cung cấp AI của trợ lý chỉ nhận lịch và bảng giá của trung tâm, không bao giờ nhận dữ liệu cá nhân của bạn.",
          "Cơ quan nhà nước, chỉ khi pháp luật yêu cầu.",
        ],
      },
      {
        heading: "Lưu trong bao lâu",
        body: [
          "Trong thời gian tài khoản còn mở. Thanh toán, biên lai và hoá đơn được lưu theo thời hạn mà pháp luật kế toán và thuế yêu cầu (hiện tại ít nhất 10 năm).",
          "Khi bạn đóng tài khoản, phần dữ liệu còn lại sẽ được xoá hoặc ẩn danh, trừ khi pháp luật yêu cầu giữ lại.",
        ],
      },
      {
        heading: "Quyền của bạn",
        body: [
          "Bạn có thể xem và sửa thông tin trong mục Tài khoản, yêu cầu bản sao dữ liệu, rút lại sự đồng ý, yêu cầu xoá hoặc ngừng sử dụng dữ liệu, và khiếu nại nếu cho rằng chúng tôi làm sai.",
          "Khi rút lại sự đồng ý hoặc xoá dữ liệu, chúng tôi sẽ không thể tiếp tục phục vụ việc đặt sân hay gói tập cho bạn. Hãy hỏi lễ tân hoặc gửi yêu cầu hỗ trợ trong app.",
        ],
      },
      {
        heading: "Trẻ em",
        body: [
          "Hội viên dưới 16 tuổi cần có người giám hộ. Họ tên và số điện thoại của người giám hộ được lưu cùng tài khoản, và người giám hộ là người đồng ý thay cho trẻ.",
        ],
      },
      {
        heading: "Bảo mật",
        body: [
          "Mật khẩu chỉ được lưu dưới dạng băm an toàn. Phiên đăng nhập của hội viên hết hạn sau bảy ngày, của nhân viên sau mười hai giờ. Mọi yêu cầu đều được kiểm tra trên máy chủ, và hội viên chỉ xem được lượt đặt, biên lai và hồ sơ của chính mình.",
          "App lưu thông tin đăng nhập và tuỳ chọn của bạn (ngôn ngữ, số dòng mỗi danh sách) trong trình duyệt. App không có công cụ theo dõi quảng cáo.",
        ],
      },
      {
        heading: "Liên hệ",
        body: ["Thắc mắc về dữ liệu của bạn: hỏi lễ tân, hoặc gửi yêu cầu hỗ trợ trong mục Tài khoản của app."],
      },
    ],
  },
};

export const TERMS: Record<"en" | "vi", LegalDoc> = {
  en: {
    title: "Terms of use",
    intro: "The rules for using the Lê Long Sport Center app and the centre. By creating an account you agree to them.",
    sections: [
      {
        heading: "Your account",
        body: [
          "One account per person, with your own real details. Keep your password to yourself; you are responsible for what is done with your account.",
          "A member under 16 signs up with a guardian, who agrees to these terms on the child's behalf.",
        ],
      },
      {
        heading: "Booking courts",
        body: [
          "A free hour you tap is held for you for a few minutes, shown as a countdown on the booking card, while you pay. If you do not pay in time, the hold ends and the court goes back on the grid.",
          "There is a limit on how many courts you can hold in a day and how far ahead you can book. The app shows these limits before you book.",
          "Some peak hours ask for a deposit now and the rest at the desk when you arrive. You can change or cancel a booking until the cut-off shown on it.",
        ],
      },
      {
        heading: "Classes",
        body: [
          "Enrolling needs an active plan that covers the class's sport, and a session plan needs sessions left. When a class is full you can join its waitlist; a seat that opens is offered to the next person for a limited time.",
          "You can leave a class until the cut-off before its next session, shown on the class card. After that, ask the front desk.",
        ],
      },
      {
        heading: "Payments",
        body: [
          "Online payments go through payOS and count once payOS confirms them. A bank transfer counts once reception finds it in the centre's account; your booking stays held meanwhile. Plans are paid at the front desk.",
          "Prices are those shown in the app and on your receipt. Refunds follow the centre's refund rules and are handled at the front desk.",
        ],
      },
      {
        heading: "At the centre",
        body: [
          "Check in at the gate with your QR code. Follow staff instructions and the safety rules posted at the centre. Hired equipment is charged to your bill and must come back in the condition it left.",
        ],
      },
      {
        heading: "Changes and contact",
        body: [
          "We may update these terms; the app tells you when they change. Questions: ask at the front desk, or send a support request from Account in the app.",
        ],
      },
    ],
  },
  vi: {
    title: "Điều khoản sử dụng",
    intro: "Quy định khi dùng app Lê Long Sport Center và sử dụng dịch vụ tại trung tâm. Khi tạo tài khoản, bạn đồng ý với các điều khoản này.",
    sections: [
      {
        heading: "Tài khoản của bạn",
        body: [
          "Mỗi người một tài khoản, với thông tin thật của chính mình. Hãy giữ kín mật khẩu; bạn chịu trách nhiệm về những gì được thực hiện bằng tài khoản của mình.",
          "Hội viên dưới 16 tuổi đăng ký cùng người giám hộ, và người giám hộ đồng ý với các điều khoản này thay cho trẻ.",
        ],
      },
      {
        heading: "Đặt sân",
        body: [
          "Giờ trống bạn chọn sẽ được giữ cho bạn trong vài phút, hiện bằng đồng hồ đếm ngược trên thẻ giữ chỗ, để bạn thanh toán. Nếu không thanh toán kịp, chỗ giữ hết hạn và sân trở lại lưới.",
          "Có giới hạn số sân bạn được giữ trong một ngày và số ngày được đặt trước. App hiển thị các giới hạn này trước khi bạn đặt.",
          "Một số giờ cao điểm cần đặt cọc trước, phần còn lại trả tại quầy khi bạn đến. Bạn có thể đổi hoặc huỷ lượt đặt trước hạn chót ghi trên lượt đặt.",
        ],
      },
      {
        heading: "Lớp học",
        body: [
          "Đăng ký lớp cần gói tập còn hiệu lực có môn của lớp, và gói theo buổi cần còn buổi. Khi lớp đầy, bạn có thể vào danh sách chờ; chỗ trống được mời người kế tiếp trong một thời gian giới hạn.",
          "Bạn có thể rời lớp trước hạn chót của buổi học kế tiếp, ghi trên thẻ lớp. Sau hạn đó, hãy liên hệ lễ tân.",
        ],
      },
      {
        heading: "Thanh toán",
        body: [
          "Thanh toán online đi qua payOS và được tính khi payOS xác nhận. Chuyển khoản được tính khi lễ tân thấy tiền trong tài khoản của trung tâm; lượt đặt của bạn vẫn được giữ trong lúc chờ. Gói tập được thanh toán tại quầy lễ tân.",
          "Giá là giá hiển thị trong app và trên biên lai. Hoàn tiền theo quy định hoàn tiền của trung tâm và được xử lý tại quầy lễ tân.",
        ],
      },
      {
        heading: "Tại trung tâm",
        body: [
          "Vào cổng bằng mã QR của bạn. Tuân theo hướng dẫn của nhân viên và nội quy an toàn niêm yết tại trung tâm. Dụng cụ thuê được tính vào hoá đơn của bạn và cần được trả lại nguyên trạng.",
        ],
      },
      {
        heading: "Thay đổi và liên hệ",
        body: [
          "Chúng tôi có thể cập nhật các điều khoản này; app sẽ báo cho bạn khi có thay đổi. Thắc mắc: hỏi lễ tân, hoặc gửi yêu cầu hỗ trợ trong mục Tài khoản của app.",
        ],
      },
    ],
  },
};
