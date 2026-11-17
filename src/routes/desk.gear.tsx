/**
 * Quản lý mượn/trả và danh mục dụng cụ thể thao (Gear/Equipment) tại quầy lễ tân.
 * Phân hệ Desk: Cho phép lễ tân và quản lý cho hội viên hoặc khách vãng lai thuê dụng cụ,
 * ghi nhận tiền thuê vào ca trực (till shift), tự động trừ/cộng tồn kho và theo dõi danh sách đang mượn.
 * Riêng tài khoản Quản lý (Manager) có quyền thêm mới các mặt hàng dụng cụ vào kho.
 */
import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/client/components/section";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Shell, money, useSessionUser } from "@/client/components/shell";
import { Button, Card, EmptyState, Field, Input, LoadError, Select, Skeleton } from "@/client/components/ui";
import { Lift, Reveal, Stagger, StaggerItem } from "@/client/components/motion";
import { SpotlightCard } from "@/client/components/fx";
import { ApiClientError, apiGet, apiPost } from "@/client/arena3/client";
import { sportLabel } from "@/shared/arena3/labels";
import { useSports } from "@/client/components/sports-ui";
import { t, tServer, tData } from "@/client/lib/i18n";
import { readError, useRead } from "@/client/lib/use-read";

/**
 * Làm gì: Định nghĩa route TanStack Router cho màn hình quản lý dụng cụ thể thao tại quầy lễ tân.
 * Được gọi ở: TanStack Router qua URL /desk/gear
 * @returns Đối tượng cấu hình route liên kết URL /desk/gear với component Page.
 */
export const Route = createFileRoute("/desk/gear")({ component: Page });

// Cấu trúc dữ liệu cho một mặt hàng dụng cụ trong kho trả về từ API /equipment.
type Item = { id: string; sku: string; name: string; sport: string | null; stock: number; rent_vnd: number };
// Cấu trúc dữ liệu cho một lượt mượn dụng cụ đang hoạt động (chưa trả) trả về từ API /equipment/loans.
type Loan = {
  id: string;
  name: string;
  sku: string;
  phone: string;
  qty: number;
  due_at: string;
  member_name: string | null;
  member_code: string | null;
};
// Cấu trúc kết quả tìm kiếm hội viên theo từ khóa trả về từ API /members.
type Hit = { id: string; member_code: string | null; full_name: string; phone: string };

// Dữ liệu rỗng ban đầu của form thêm dụng cụ mới dành cho tài khoản Manager.
const BLANK = { name: "", sku: "", sport: "", stock: "0", rent_vnd: "0" };

/**
 * Làm gì: Component giao diện chính phục vụ nghiệp vụ thuê dụng cụ, thu hồi đồ mượn và thêm dụng cụ mới vào kho.
 * Được gọi ở: TanStack Router khi người dùng truy cập route /desk/gear (Route.component).
 * @returns Giao diện Shell chứa danh mục dụng cụ, form cho thuê và bảng danh sách đồ đang cho mượn.
 */
function Page() {
  // Bước 1: Khởi tạo thông tin phiên người dùng, quyền Manager và các hook nạp dữ liệu kho, danh sách mượn.
  const user = useSessionUser();
  const isManager = user?.role === "manager";
  const sports = useSports();
  // Only the manager adds lines to the shelf; the desk rents out what is listed.
  const [draft, setDraft] = useState(BLANK);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<{ field: string; message: string } | null>(null);
  // null = not known yet (still asking, or the question failed) — never "nothing": an empty shelf and an
  // empty loan list are claims about the stock room, and a screen that has not heard back cannot make them.
  const equipmentRead = useRead<{ items: Item[] }>("/equipment");
  const loansRead = useRead<{ items: Loan[] }>("/equipment/loans");
  const items = equipmentRead.data?.items ?? null;
  const loans = loansRead.data?.items ?? null;
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState(1);
  const [method, setMethod] = useState("cash");
  const [who, setWho] = useState<"member" | "guest">("member");
  const [phone, setPhone] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  // The search text the list above was last answered for, so "no match" is said only about what was typed.
  const [answered, setAnswered] = useState<string | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searchTry, setSearchTry] = useState(0);
  const [member, setMember] = useState<Hit | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [returning, setReturning] = useState<string | null>(null);

  // Stock and loans both move when gear goes out or comes back, so every change re-asks for both.
  /**
   * Làm gì: Tải lại đồng thời dữ liệu danh mục dụng cụ (/equipment) và các lượt mượn (/equipment/loans) từ server để cập nhật số tồn kho và danh sách đồ đang mượn.
   * Được gọi ở: src/routes/desk.gear.tsx, trong các hàm rent(), addItem(), takeBack().
   * @returns Không trả về giá trị (void).
   */
  function reloadAll() {
    equipmentRead.reload();
    loansRead.reload();
  }

  // Start on something that can actually be rented, not on a line that is greyed out.
  useEffect(() => {
    if (items?.length) setItemId((cur) => cur || (items.find((i) => i.stock > 0) ?? items[0])?.id || "");
  }, [items]);

  useEffect(() => {
    setSearchErr(null);
    // Điều kiện tìm kiếm: Chỉ tra cứu khi thuê cho hội viên, chưa chọn ai và từ khóa đạt từ 3 ký tự trở lên.
    if (who !== "member" || member || q.trim().length < 3) {
      setHits([]);
      setAnswered(null);
      return;
    }
    let stale = false;
    // Debounce 180ms để tránh spam API tìm kiếm thành viên khi người dùng gõ liên tục.
    const timer = setTimeout(() => {
      apiGet<{ items: Hit[] }>(`/members?q=${encodeURIComponent(q)}`).then(
        (r) => {
          // Bỏ qua kết quả nếu request này đã bị lỗi thời (stale) do người dùng tiếp tục gõ từ khóa mới.
          if (stale) return;
          setHits(r.items);
          setAnswered(q);
        },
        (e: unknown) => {
          if (stale) return;
          setHits([]);
          setAnswered(null);
          setSearchErr(readError(e).message);
        },
      );
    }, 180);
    // Dọn dẹp: Hủy bộ hẹn giờ và đánh dấu request hiện tại là lỗi thời khi component unmount hoặc từ khóa thay đổi.
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q, who, member, searchTry]);

  const item = items?.find((i) => i.id === itemId);
  const max = item?.stock ?? 0;
  // Keep the count inside what is on the shelf when the item (or its stock) changes.
  const shown = Math.max(1, Math.min(qty, Math.max(max, 1)));
  // Điều kiện cho thuê: Phải chọn món đồ còn tồn kho và xác định được người thuê (hội viên hoặc khách có SĐT).
  const canRent = !!item && max > 0 && (who === "member" ? !!member : phone.trim().length > 0);

  /**
   * Làm gì: Lập phiếu cho thuê dụng cụ cho hội viên hoặc khách vãng lai, trừ tồn kho và ghi nhận tiền thuê vào ca trực lễ tân.
   * Được gọi ở: src/routes/desk.gear.tsx, trong sự kiện onClick của nút "Rent out" (dòng 380).
   * @returns Không trả về giá trị (void).
   */
  async function rent() {
    // Bước 1: Xóa thông báo lỗi trường dữ liệu cũ trước khi gửi request.
    setFieldError(null);
    try {
      // Bước 2: Gọi API tạo lượt mượn; truyền user_id nếu là hội viên, hoặc số điện thoại nếu là khách.
      const r = await apiPost<{ rent_vnd: number }>("/equipment/loans", {
        item_id: itemId,
        qty: shown,
        method,
        ...(who === "member" ? { user_id: member?.id } : { phone }),
      });
      // Bước 3: Thông báo thành công kèm số tiền thuê đã ghi nhận vào ca trực thu ngân.
      toast.success(t("Rented out · {amount}", { amount: money(r.rent_vnd) }));
      // Bước 4: Đặt lại form thuê về mặc định và xóa thông tin người thuê vừa chọn.
      setQty(1);
      setPhone("");
      setMember(null);
      setQ("");
      // Bước 5: Tải lại dữ liệu kho và danh sách mượn để cập nhật số lượng tồn kho tức thì.
      reloadAll();
    } catch (e) {
      // Bước 6: Xử lý lỗi; nếu lỗi thuộc về trường cụ thể (hết tồn kho, sai SĐT) thì gán vào fieldError để hiện dưới ô nhập.
      if (e instanceof ApiClientError && e.body.field) setFieldError({ field: e.body.field, message: tServer(e.message) });
      else toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
      reloadAll();
    }
  }

  /**
   * Làm gì: Tạo mới một mặt hàng dụng cụ thể thao vào kho (chỉ dành cho Manager), bao gồm tên, SKU, môn thể thao, số lượng và giá thuê.
   * Được gọi ở: src/routes/desk.gear.tsx, trong sự kiện onClick của nút "Add" thuộc form thêm dụng cụ (dòng 208).
   * @returns Không trả về giá trị (void).
   */
  async function addItem() {
    // Bước 1: Xóa lỗi cũ và bật cờ adding để vô hiệu hóa nút bấm, tránh submit nhiều lần.
    setAddError(null);
    setAdding(true);
    try {
      // Bước 2: Gọi API thêm mới dụng cụ vào kho (yêu cầu vai trò Manager).
      await apiPost("/equipment", {
        name: draft.name,
        sku: draft.sku,
        sport: draft.sport || null,
        stock: draft.stock,
        rent_vnd: draft.rent_vnd,
      });
      // Bước 3: Thông báo thành công, làm sạch form nhập về rỗng và tải lại danh mục thiết bị.
      toast.success(t("Gear added"));
      setDraft(BLANK);
      reloadAll();
    } catch (e) {
      // Bước 4: Bắt lỗi validation từ server; nếu lỗi theo trường cụ thể (ví dụ trùng SKU) thì hiển thị cạnh ô nhập đó.
      if (e instanceof ApiClientError && e.body.field) setAddError({ field: e.body.field, message: tServer(e.message) });
      else toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      // Bước 5: Hoàn tất quá trình thêm và mở lại trạng thái nút bấm.
      setAdding(false);
    }
  }
  /**
   * Làm gì: Lấy thông điệp lỗi validation tương ứng cho từng trường trong form thêm dụng cụ của Manager.
   * Được gọi ở: src/routes/desk.gear.tsx, trong thuộc tính hint và tone của các component Field thuộc form thêm đồ.
   * @param field Tên trường cần lấy thông điệp lỗi (ví dụ: "name", "sku", "stock", "rent_vnd").
   * @returns Chuỗi thông báo lỗi nếu trường đó vi phạm, ngược lại trả về undefined.
   */
  const addHint = (field: string) => (addError?.field === field ? addError.message : undefined);
  /**
   * Làm gì: Tạo hàm xử lý onChange cho từng trường trong form thêm dụng cụ mới, cập nhật giá trị vào state draft và xóa lỗi cũ.
   * Được gọi ở: src/routes/desk.gear.tsx, trong sự kiện onChange của các ô Input và Select trong form thêm đồ.
   * @param k Tên thuộc tính trong đối tượng BLANK ("name" | "sku" | "sport" | "stock" | "rent_vnd").
   * @returns Hàm callback nhận sự kiện thay đổi giá trị từ thẻ input/select.
   */
  const edit = (k: keyof typeof BLANK) => (e: { target: { value: string } }) => {
    // Cập nhật giá trị thuộc tính tương ứng trong state draft và xóa lỗi validation cũ.
    setDraft((d) => ({ ...d, [k]: e.target.value }));
    setAddError(null);
  };

  /**
   * Làm gì: Xử lý thu hồi dụng cụ đã cho mượn, cập nhật trạng thái phiếu mượn sang 'returned' và cộng trả lại số lượng vào tồn kho.
   * Được gọi ở: src/routes/desk.gear.tsx, trong sự kiện onClick của nút "Take it back" ở từng dòng phiếu mượn (dòng 430).
   * @param l Đối tượng phiếu mượn (Loan) cần hoàn trả dụng cụ.
   * @returns Không trả về giá trị (void).
   */
  async function takeBack(l: Loan) {
    // Bước 1: Ghi nhận id phiếu đang trả để vô hiệu hóa nút bấm tương ứng, ngăn click lặp lại.
    setReturning(l.id);
    try {
      // Bước 2: Gọi API hoàn trả dụng cụ để cập nhật trạng thái phiếu sang 'returned' và hoàn lại tồn kho.
      await apiPost(`/equipment/loans/${l.id}/return`);
      // Bước 3: Thông báo trả dụng cụ thành công cho lễ tân.
      toast.success(t("Returned"));
    } catch (e) {
      // Bước 4: Hiển thị thông báo lỗi nếu server từ chối yêu cầu trả dụng cụ.
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      // Bước 5: Bỏ khóa nút bấm và tải lại toàn bộ danh mục cùng danh sách mượn.
      setReturning(null);
      reloadAll();
    }
  }

  // Kiểm tra xem lỗi trả về từ server có liên quan đến đối tượng thuê (SĐT khách hoặc user_id hội viên) hay không.
  const phoneProblem = fieldError && (fieldError.field === "phone" || fieldError.field === "user_id") ? fieldError : null;

  // Bước 2: Render giao diện: Form thêm đồ cho Manager (nếu có quyền), form thuê đồ, danh mục trong kho và danh sách đang mượn.
  return (
    <Shell
      role={isManager ? "manager" : "receptionist"}
      title={t("Gear")}
      subtitle={t("Rent to a member's account or to a guest by phone. The hire is charged to the till, stock comes down on the way out and back up on return.")}
    >
      {isManager ? (
        <Card className="mb-4">
          <p className="font-medium">{t("Add gear")}</p>
          <p className="text-sm text-muted">{t("List a new item, for example for a sport you have just added.")}</p>
          <div className="mt-3 grid gap-3 md:grid-cols-[1.6fr_1fr_1fr_0.7fr_1fr_auto]">
            <Field label={t("Name")} hint={addHint("name")} tone={addHint("name") ? "danger" : "muted"}>
              <Input value={draft.name} maxLength={80} placeholder={t("e.g. Squash racket")} onChange={edit("name")} />
            </Field>
            <Field label={t("Code")} hint={addHint("sku")} tone={addHint("sku") ? "danger" : "muted"}>
              <Input value={draft.sku} maxLength={24} placeholder="SQ-RACKET" onChange={edit("sku")} />
            </Field>
            <Field label={t("Sport")} hint={addHint("sport")} tone={addHint("sport") ? "danger" : "muted"}>
              <Select value={draft.sport} onChange={edit("sport")}>
                <option value="">{t("General")}</option>
                {sports.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name ?? sportLabel(s.code)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("Stock")} hint={addHint("stock")} tone={addHint("stock") ? "danger" : "muted"}>
              <Input inputMode="numeric" value={draft.stock} onChange={edit("stock")} />
            </Field>
            <Field label={t("Hire price (VND)")} hint={addHint("rent_vnd")} tone={addHint("rent_vnd") ? "danger" : "muted"}>
              <Input inputMode="numeric" value={draft.rent_vnd} onChange={edit("rent_vnd")} />
            </Field>
            <div className="flex items-end">
              <Button
                className="w-full"
                disabled={adding || !draft.name.trim() || !draft.sku.trim()}
                onClick={() => void addItem()}
              >
                {t("Add")}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
      {equipmentRead.error ? (
        <div className="mb-4">
          <LoadError
            message={equipmentRead.error.message}
            onRetry={equipmentRead.error.refused ? undefined : equipmentRead.reload}
          />
        </div>
      ) : !items ? (
        <Skeleton className="mb-4 h-32" />
      ) : !items.length ? (
        <div className="mb-4">
          <EmptyState title={t("No gear is listed yet")} />
        </div>
      ) : (
        <Reveal from="down">
          <Card className="mb-4 grid gap-3 md:grid-cols-[1.2fr_1.6fr_auto_auto_auto]">
            <Field label={t("Item")}>
              <Select
                value={itemId}
                onChange={(e) => {
                  setItemId(e.target.value);
                  setQty(1);
                }}
              >
                {items.map((i) => (
                  <option key={i.id} value={i.id} disabled={i.stock < 1}>
                    {tData(i.name)} · {i.stock ? t("{n} left", { n: i.stock }) : t("none left")} · {money(i.rent_vnd)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid content-start gap-2">
              <div className="flex gap-1 text-sm" role="tablist" aria-label={t("Who is renting")}>
                {(["member", "guest"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={who === k}
                    onClick={() => {
                      setWho(k);
                      setFieldError(null);
                    }}
                    className={`min-h-11 rounded-full px-4 py-1 sm:min-h-9 ${who === k ? "bg-accent text-accent-fg" : "bg-wood text-muted"}`}
                  >
                    {k === "member" ? t("Member") : t("Guest")}
                  </button>
                ))}
              </div>
              {who === "member" ? (
                member ? (
                  <div className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-wood/60 px-3 py-2 text-sm">
                    <span>
                      <span className="font-medium">{member.full_name}</span>{" "}
                      <span className="tabular-nums text-muted">
                        {member.member_code ?? ""} · {member.phone}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="text-muted underline"
                      onClick={() => {
                        setMember(null);
                        setFieldError(null);
                      }}
                    >
                      {t("Change")}
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <Input
                      aria-label={t("Find a member")}
                      placeholder={t("Search name, phone or member code")}
                      value={q}
                      aria-invalid={phoneProblem ? true : undefined}
                      onChange={(e) => {
                        setQ(e.target.value);
                        setFieldError(null);
                      }}
                    />
                    {hits.length ? (
                      <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-[var(--radius-md)] border border-line bg-surface text-sm shadow-lg">
                        {hits.map((h) => (
                          <li key={h.id}>
                            <button
                              type="button"
                              className="flex w-full justify-between gap-2 px-3 py-2 text-left hover:bg-wood"
                              onClick={() => {
                                setMember(h);
                                setHits([]);
                              }}
                            >
                              <span className="font-medium">{h.full_name}</span>
                              <span className="tabular-nums text-muted">
                                {h.member_code ?? ""} · {h.phone}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {q.trim().length >= 3 && answered === q && !hits.length && !searchErr ? (
                      <p className="mt-1.5 text-sm text-muted">{t("No members match")}</p>
                    ) : null}
                  </div>
                )
              ) : (
                <Input
                  aria-label={t("Guest phone")}
                  inputMode="tel"
                  placeholder={t("Guest phone, e.g. 09xx xxx xxx")}
                  value={phone}
                  aria-invalid={phoneProblem ? true : undefined}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setFieldError(null);
                  }}
                />
              )}
              {searchErr && who === "member" && !member ? (
                <LoadError message={searchErr} onRetry={() => setSearchTry((n) => n + 1)} />
              ) : null}
              {phoneProblem ? (
                <p role="alert" className="text-sm text-danger">
                  {phoneProblem.message}
                </p>
              ) : null}
            </div>
            <Field label={t("Qty")}>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="min-w-11"
                  aria-label={t("One fewer")}
                  disabled={shown <= 1}
                  onClick={() => setQty(shown - 1)}
                >
                  −
                </Button>
                <span className="w-8 text-center tabular-nums" aria-live="polite">
                  {shown}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-w-11"
                  aria-label={t("One more")}
                  disabled={shown >= max}
                  onClick={() => setQty(shown + 1)}
                >
                  +
                </Button>
              </div>
            </Field>
            <Field label={t("Paid by")}>
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="cash">{t("Cash")}</option>
                <option value="card">{t("Card")}</option>
                <option value="transfer">{t("Bank transfer")}</option>
              </Select>
            </Field>
            <div className="flex items-end">
              <Button className="w-full" disabled={!canRent} onClick={() => void rent()}>
                {t("Rent out")}
              </Button>
            </div>
          </Card>
        </Reveal>
      )}
      {items?.length ? (
        <Stagger className="grid gap-3 md:grid-cols-2" gap={0.05}>
          {items.map((i) => (
            <StaggerItem key={i.id} className="h-full">
              <Lift className="h-full">
                <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={280} strength={0.1}>
                  <Card interactive className="relative z-[2] h-full p-4">
                    <p className="text-2xs text-muted">{i.sport ? sportLabel(i.sport) : t("General")}</p>
                    <p className="font-medium">{tData(i.name)}</p>
                    <p className="text-sm text-muted">
                      {t("{n} in stock · {amount} each", { n: i.stock, amount: money(i.rent_vnd) })}
                    </p>
                  </Card>
                </SpotlightCard>
              </Lift>
            </StaggerItem>
          ))}
        </Stagger>
      ) : null}
      <SectionTitle text={t("Out on loan")} className="mt-8 font-display text-2xl" />
      {loansRead.error ? (
        <div className="mt-3">
          <LoadError
            message={loansRead.error.message}
            onRetry={loansRead.error.refused ? undefined : loansRead.reload}
          />
        </div>
      ) : !loans ? (
        <Skeleton className="mt-3 h-16" />
      ) : (
        <Stagger className="mt-3 grid gap-2" gap={0.05}>
          {loans.map((l) => (
            <StaggerItem key={l.id}>
              <Card className="flex items-center justify-between p-4">
                <div>
                  <p className="font-medium">
                    {tData(l.name)} × {l.qty}
                  </p>
                  <p className="text-xs text-muted">
                    {l.member_name ? `${l.member_name}${l.member_code ? ` · ${l.member_code}` : ""} · ` : `${t("Guest")} · `}
                    {l.phone}
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={returning === l.id} onClick={() => void takeBack(l)}>
                  {t("Take it back")}
                </Button>
              </Card>
            </StaggerItem>
          ))}
          {!loans.length ? <p className="text-sm text-muted">{t("Nothing is out right now.")}</p> : null}
        </Stagger>
      )}
    </Shell>
  );
}
