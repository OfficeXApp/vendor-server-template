import { useState, useEffect } from "react";
import {
  Layout,
  Input,
  Button,
  Card,
  Typography,
  Space,
  Divider,
  DatePicker,
  QRCode,
  Tooltip,
  Row,
  Col,
  Popover,
  Alert,
  message,
} from "antd";
import {
  SyncOutlined,
  DownloadOutlined,
  CopyOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  SettingFilled,
} from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";

import { Column } from "@ant-design/charts"; // Import the Column chart component
import type { CheckoutWalletFE, CustomerPurchaseFE } from "./types";
import { HARDCODED_STABLECOIN_BASE } from "./constants";
import type { IRequestCheckoutTopup, IResponseCheckoutTopup } from "@officexapp/types";

const { Title, Paragraph, Text } = Typography;
const { Header, Content } = Layout;

const { RangePicker } = DatePicker;

// The user-provided UsageRecord interface for data structure
interface UsageRecord {
  id?: number;
  purchase_id: string;
  timestring: string;
  timestamp: Date;
  usage_amount: number;
  usage_unit: string;
  billed_amount: number;
  description?: string;
  metadata?: Record<string, any>;
}

// Generate mock data for 30 days with stacked usage units
const generateMockUsageData = (): UsageRecord[] => {
  const data: UsageRecord[] = [];
  const today = dayjs();

  for (let i = 0; i < 30; i++) {
    const date = today.subtract(i, "day").startOf("day").toDate();

    // Data for "API calls"
    data.push({
      purchase_id: "purchase-1",
      timestamp: date,
      timestring: date.toLocaleString("en-US", { month: "long", day: "numeric" }),
      usage_amount: Math.floor(Math.random() * 50) + 50,
      usage_unit: "API calls",
      billed_amount: parseFloat((Math.random() * 5).toFixed(2)),
    });

    // Data for "GPU hours"
    data.push({
      purchase_id: "purchase-1",
      timestamp: date,
      timestring: date.toLocaleString("en-US", { month: "long", day: "numeric" }),
      usage_amount: parseFloat((Math.random() * 5).toFixed(2)),
      usage_unit: "GPU hours",
      billed_amount: parseFloat((Math.random() * 10).toFixed(2)),
    });

    // Data for "MB storage"
    data.push({
      purchase_id: "purchase-1",
      timestamp: date,
      timestring: date.toLocaleString("en-US", { month: "long", day: "numeric" }),
      usage_amount: Math.floor(Math.random() * 200) + 100,
      usage_unit: "MB storage",
      billed_amount: parseFloat((Math.random() * 2).toFixed(2)),
    });
  }
  return data.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
};

const App = () => {
  const [vendorPurchaseId, setVendorPurchaseId] = useState("");
  const [customerBillingApiKey, setCustomerBillingApiKey] = useState("");
  const [reciept, setReciept] = useState<{ purchase: CustomerPurchaseFE; checkout_wallet: CheckoutWalletFE } | null>(
    null,
  );
  const [usageData] = useState<UsageRecord[]>(generateMockUsageData());
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null]>([dayjs().subtract(30, "day"), dayjs()]);
  const [loading] = useState(false);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const purchaseId = urlParams.get("vendor_purchase_id");
    const apiKey = urlParams.get("customer_billing_api_key");

    console.log(`purchaseId: ${purchaseId}`);
    console.log(`apiKey: ${apiKey}`);

    if (!purchaseId || !apiKey) {
      setReciept(null);
      return;
    }

    if (purchaseId) setVendorPurchaseId(purchaseId);
    if (apiKey) setCustomerBillingApiKey(apiKey);

    const fetchInitial = async () => {
      const data = await fetch(`${window.location.origin}/v1/purchase/${purchaseId}`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      });
      const json = await data.json();
      console.log(json);
      setReciept(json);
    };
    fetchInitial();
  }, []);

  const handleDateRangeChange = (dates: [Dayjs | null, Dayjs | null] | null) => {
    if (dates) {
      setDateRange(dates);
    } else {
      setDateRange([null, null]);
    }
  };

  // const handleDownloadDetails = () => {
  //   const awsCredentials = {
  //     vendorPurchaseId: vendorPurchaseId,
  //     apiKey: customerBillingApiKey,
  //     aws: {
  //       accessKeyId: "YOUR_AWS_ACCESS_KEY",
  //       secretAccessKey: "YOUR_AWS_SECRET_ACCESS_KEY",
  //       region: "us-east-1",
  //     },
  //   };
  //   const jsonString = `data:text/json;charset=utf-8,${encodeURIComponent(JSON.stringify(awsCredentials, null, 2))}`;
  //   const link = document.createElement("a");
  //   link.href = jsonString;
  //   link.download = "aws_credentials.json";
  //   document.body.appendChild(link);
  //   link.click();
  //   link.remove();
  // };

  const handleDownloadRawData = () => {
    const jsonString = `data:text/json;charset=utf-8,${encodeURIComponent(JSON.stringify(usageData, null, 2))}`;
    const link = document.createElement("a");
    link.href = jsonString;
    link.download = "raw_usage_data.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    message.success("Copied to clipboard");
  };

  // Configuration for the stacked Column chart
  // Configuration for the stacked Column chart
  const chartConfig = {
    data: usageData,
    xField: "timestring",
    yField: "billed_amount",
    isStack: true,
    seriesField: "usage_unit",
    label: {
      position: "middle",
      layout: [{ type: "interval-hide-overlap" }],
      style: {
        fill: "#FFFFFF",
        opacity: 0.6,
      },
    },
    tooltip: {
      // The customContent property provides full control over the tooltip's rendering
      customContent: (title: string, data: any[]) => {
        if (!data || data.length === 0) {
          return null;
        }
        // Format the full date for the tooltip title
        const tooltipTitle = dayjs(title).format("MMMM D, YYYY");
        return (
          <div style={{ padding: "12px" }}>
            <p style={{ fontWeight: "bold", marginBottom: "8px" }}>{tooltipTitle}</p>
            <ul style={{ listStyleType: "none", padding: 0, margin: 0 }}>
              {data.map((item, index) => (
                <li key={index} style={{ marginBottom: "4px" }}>
                  <span
                    style={{
                      display: "inline-block",
                      width: "10px",
                      height: "10px",
                      backgroundColor: item.color,
                      marginRight: "8px",
                    }}
                  ></span>
                  <span style={{ fontWeight: "bold" }}>{item.name}: </span>
                  <span>{`${item.data.usage_amount} ${item.name} ($${item.data.billed_amount.toFixed(2)})`}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      },
    },
    meta: {
      timestamp: {
        alias: "Date",
        type: "time",
        // Format the date for the axis to be more compact
        formatter: (val: any) => dayjs(val).format("MMM D"),
      },
      billed_amount: {
        alias: "Billed Amount ($)",
        formatter: (val: any) => `$${val.toFixed(2)}`,
      },
      usage_unit: {
        alias: "Usage Type",
      },
    },
  };

  const validatePayment = async () => {
    console.log(`validating payment....`);
    if (!vendorPurchaseId || !customerBillingApiKey) {
      console.log(`vendorPurchaseId or customerBillingApiKey is missing`);
      return;
    }
    const data = await fetch(`${window.location.origin}/v1/checkout/topup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerBillingApiKey}`,
      },
      body: JSON.stringify({
        checkout_session_id: reciept?.checkout_wallet.checkout_session_id,
        sweep_tokens: [HARDCODED_STABLECOIN_BASE.address],
      } as IRequestCheckoutTopup),
    });
    const json: IResponseCheckoutTopup = await data.json();
    console.log(json);
    // @ts-ignore
    setReciept((r) => ({
      ...r,
      checkout_wallet: {
        ...r?.checkout_wallet,
        latest_usd_balance: json.updatedValue,
      },
    }));
  };

  return (
    <Layout
      style={{
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
      }}
    >
      <div style={{ width: "100%", maxWidth: "600px" }}>
        <Header className="bg-white shadow p-4 flex flex-col md:flex-row items-center justify-between">
          <div style={{ display: "flex", alignItems: "space-between", gap: 16 }}>
            <span
              style={{
                color: "white",
                fontSize: "1.2rem",
                textAlign: "left",
                marginRight: 16,
                flex: 1,
                alignItems: "center",
                display: "flex",
              }}
            >
              <img src="./favicon.ico" width={24} height={24} style={{ marginRight: 8 }} /> E-Receipt Billing
            </span>

            <a
              href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
              target="_blank"
              className="mt-2 md:mt-0"
              style={{ marginLeft: 16, color: "white" }}
            >
              Help
            </a>
            <Popover
              content={
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <b>Enter Purchase Record</b>
                  <Input
                    placeholder="Vendor Purchase ID"
                    value={vendorPurchaseId}
                    onChange={(e) => setVendorPurchaseId(e.target.value)}
                    style={{ width: "200px" }}
                  />
                  <Input.Password
                    placeholder="Billing API Key"
                    value={customerBillingApiKey}
                    onChange={(e) => setCustomerBillingApiKey(e.target.value)}
                    style={{ width: "200px" }}
                  />
                  <Tooltip title="Refresh Data">
                    <Button type="primary" icon={<SyncOutlined />} loading={loading}>
                      Refresh
                    </Button>
                  </Tooltip>
                </div>
              }
            >
              <SettingFilled color="white" style={{ color: "white", fontSize: "1.3rem" }} />
            </Popover>
          </div>
        </Header>

        {reciept ? (
          <Content className="p-4 md:p-8">
            <div className="max-w-7xl mx-auto">
              <Card className="rounded-xl shadow-lg mb-8">
                <Input
                  value={vendorPurchaseId}
                  prefix={<CopyOutlined onClick={() => handleCopy(vendorPurchaseId)} />}
                  bordered={false}
                  style={{ color: "rgba(0,0,0,0.35)", backgroundColor: "rgba(0,0,0,0.02)" }}
                  placeholder="Enter your purchase record details in settings ⚙"
                />
                <Title level={2} className="!mt-0">
                  {reciept.purchase.title}
                </Title>
                <Text className="block text-xl text-gray-700">{reciept.purchase.price_line}</Text>
                <br />
                <a
                  href={`${reciept.purchase.customer_org_endpoint}/org/${reciept.purchase.customer_org_id}/resources/contacts/${reciept.purchase.customer_user_id}`}
                  target="_blank"
                  className="block mt-2"
                >
                  Purchased by this Customer
                </a>
                <Divider />
                <p className="text-gray-600">{reciept.checkout_wallet.description}</p>
                <Button icon={<InfoCircleOutlined />} className="mt-4 w-full rounded-md">
                  Contact Support
                </Button>
                <br />
                <div style={{ paddingTop: "8px" }}>
                  <i style={{ color: "#999" }}>vendor@email.com</i>
                </div>
              </Card>
              <br />
              <Card className="rounded-xl shadow-lg mb-8">
                <Title level={4}>Top Up Wallet</Title>
                <div style={{ marginBottom: 12 }}>
                  <Text>Current Balance: {reciept.checkout_wallet.latest_usd_balance} USDC</Text>
                </div>
                <div style={{ marginTop: 16 }}>
                  <Row gutter={[8, 16]} align="top" justify="start">
                    <Col xs={24} md={8} style={{ textAlign: "left" }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "left",
                          padding: "0px 0",
                          flexDirection: "column",
                        }}
                      >
                        <QRCode value={"0xBC14B7C4F483D3276549DE7daEfCe3927Df6deB3"} size={180} />
                      </div>
                    </Col>
                    <Col xs={24} md={16}>
                      <Paragraph style={{ marginBottom: "8px" }}>
                        Send{" "}
                        <Text
                          strong
                          style={{
                            borderBottom: "1px dashed #999",
                            cursor: "pointer",
                          }}
                          onClick={() => null}
                        >
                          USDC
                        </Text>{" "}
                        on{" "}
                        <Text
                          strong
                          style={{
                            borderBottom: "1px dashed #999",
                            cursor: "pointer",
                          }}
                          onClick={() => null}
                        >
                          Base L2
                        </Text>
                        :
                      </Paragraph>
                      <div style={{ marginTop: 4, marginBottom: 12 }}>
                        <Input
                          readOnly
                          value={reciept?.checkout_wallet.evm_address}
                          addonBefore={
                            <Space size={4}>
                              <Text strong>Receiver</Text>{" "}
                              <Popover
                                content={
                                  "The unique address for the deposit on the selected chain. Click to view on chain explorer."
                                }
                                title="Deposit Address Explanation"
                                trigger="hover"
                              >
                                <InfoCircleOutlined style={{ color: "rgba(0,0,0,.45)" }} />
                              </Popover>
                            </Space>
                          }
                          suffix={
                            <Space size={4}>
                              <LinkOutlined style={{ cursor: "pointer", color: "#666" }} onClick={() => null} />
                              <CopyOutlined
                                style={{ cursor: "pointer", color: "#666" }}
                                onClick={() => handleCopy(reciept?.checkout_wallet.evm_address)}
                              />
                            </Space>
                          }
                        />
                      </div>

                      <Paragraph type="secondary" style={{ fontSize: "13px", marginTop: "4px" }}>
                        Vendor Disclaimer: This is a test vendor.
                      </Paragraph>

                      <Button block type="primary" size="large" onClick={validatePayment}>
                        Validate Payment
                      </Button>
                    </Col>
                  </Row>
                </div>
                <Alert
                  message={
                    <div>
                      <span>
                        Always make sure your purchase wallet has enough balance to cover your future usage. If you run
                        out of balance, you will not be able to use the service and data may be deleted.
                      </span>
                      <br />
                      <br />
                      <span>
                        Send more money to your purchase wallet to avoid this, click validate payment to see updated
                        balance. Minimum $1 USDC deposit, $0.40 gas fee applies.
                      </span>
                    </div>
                  }
                  type="warning"
                  style={{ marginTop: "16px" }}
                />
              </Card>
              <br />
              <Card className="rounded-xl shadow-lg">
                <Title level={4} className="!mt-0">
                  Usage Based Billing History
                </Title>
                <Space className="w-full mb-4 md:mb-0" wrap>
                  <RangePicker
                    value={dateRange}
                    onChange={handleDateRangeChange}
                    className="w-full md:w-80 rounded-md"
                  />
                  <Button
                    type="primary"
                    ghost
                    icon={<SyncOutlined />}
                    loading={loading}
                    className="w-full md:w-auto rounded-md"
                  >
                    Refresh
                  </Button>
                </Space>
                <br />
                <br />

                <div className="mt-4">
                  <Column {...chartConfig} loading={loading} />
                </div>

                <Button
                  type="default"
                  icon={<DownloadOutlined />}
                  onClick={handleDownloadRawData}
                  className="mt-4 w-full rounded-md"
                >
                  Download Raw Data
                </Button>
              </Card>
              <br />
              <br />
            </div>
          </Content>
        ) : (
          <Content className="p-4 md:p-8">
            <Alert
              message="No purchase found"
              description="Please check the purchase ID in ⚙️ and try again."
              type="warning"
              showIcon
            />
          </Content>
        )}
      </div>
    </Layout>
  );
};

export default App;
