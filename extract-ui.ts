curl -X POST "http://127.0.0.1:3845/messages?sessionId=b0e842d3-184a-4075-8d10-f279c7e4d2c5" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'


curl -X POST "http://127.0.0.1:3845/messages?sessionId=b0e842d3-184a-4075-8d10-f279c7e4d2c5" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2,"params":{}}'

# Step 1: Initialize and get a session ID
curl -X POST http://localhost:3845/mcpcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}'

# Step 2: Use the returned sessionId in subsequent requests
curl -X POST http://localhost:3845/mcpcp \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: <id from step 1>" \
  -d '{"jsonrpc":"2.0","method":"your_method","params":{},"id":2}'





u# CLAUDE.md — mca-eps-savings-acc-open

## What This File Is
Single source of truth for Claude Code on this repo.
Every existing endpoint is documented as a reference pattern.
To add a new endpoint, follow the **"New Endpoint Checklist"** at the bottom and clone any existing endpoint's pattern.

---

## Project Context

- **Service**: Barclays MCA EPS — Savings Account Open microservice
- **Language**: Java 17, Spring Boot
- **Base package**: `com.barclays.mca.eps.savingsaccountopen`
- **Main class**: `SavingsAccountOpenApplication`
- **Branch convention**: `dev/SAVEAOP-XXXXX`
- **Encoding / indent**: UTF-8, LF, 2 spaces (check file before editing — some files use 4)

---

## Project Structure

```
src/main/java/.../savingsaccountopen/
├── packages/customer/
│   ├── controller/          → CustomerController (REST entry points)
│   ├── domain/
│   │   ├── request/         → Inbound domain objects
│   │   └── response/        → Outbound response models
│   ├── helper/              → SaveApplicationHelper, EligibilityHelper, PaymentAccountHelper
│   ├── mapper/
│   │   ├── impl/            → CustomerMapperImpl
│   │   ├── CustomerMapper.java          (interface — builds RestConnectorRequest)
│   │   └── CustomerResponseMapper.java  (@Mapper interface — maps API data to response models)
│   ├── request/strategy/    → One Strategy class per endpoint
│   ├── service/
│   │   ├── impl/            → CustomerServiceImpl, EligibilityServiceImpl
│   │   └── CustomerService / EligibilityService (interfaces)
│   └── util/                → CustomerAuditHelper, CustomerConstants, enums
├── request/
│   ├── RequestFactory.java  → Auto-discovers all strategies via Spring — NEVER MODIFY
│   ├── RequestStrategy.java → Interface all strategies implement
│   └── UrlBuilderService.java → Builds URLs from EndpointType + RequestContext
resources/
├── application.properties / application-dev.properties
└── eps_curls.json
```

---

## Universal Conventions (Every Endpoint Must Follow These)

### IOLSchema — always extract via utils, never direct field access
```java
savingsAccOpenUtil.validateIOLSchemaNotNull(iolSchema, featureName);
String customerId  = savingsAccOpenUtil.getCustomerIdFromContext(iolSchema.getCustomerContext(), featureName);
String productCode = secureContextUtil.getSecureContextValue(iolSchema, PRODUCT_CODE, featureName);
String corrId      = SavingsAccOpenUtil.getCorrelationIdFromContext(iolSchema);
String ntbValue    = savingsAccOpenUtil.getProcessContextValue(iolSchema.getProcessContext(), NTB);
```

### Logging — mandatory in every service method
```java
LogUtil.info(getClass(), message: "Outcome=START | method=<name> | feature=%s | corrId=%s",
    FeatureKey.AT.getFeatureName(), corrId);
LogUtil.info(getClass(), message: "Outcome=SUCCESS | method=<name> | corrId=%s", corrId);
LogUtil.error(getClass(), message: "Outcome=FAILURE | method=<name> | corrId=%s | message=%s",
    ex, corrId, ex.getMessage());
```

### Exception shape — mandatory catch order
```java
} catch (SavingsAccOpenEpsException ex) {
    isSuccess = false;
    CustomerAuditHelper.addErrorDetails(auditData, ex.getMessage());
    throw ex;
} catch (Exception ex) {
    isSuccess = false;
    LogUtil.error(...);
    CustomerAuditHelper.addErrorDetails(auditData, ex.getMessage());
    throw new SavingsAccOpenEpsException(
        ErrorsEnum.EPS_SYS_ERR.getErrorCode(),
        ErrorsEnum.EPS_SYS_ERR.getErrorDescription(),
        ErrorsEnum.EPS_SYS_ERR.getHttpStatusCode(),
        featureName
    );
} finally {
    logAuditEntry(isSuccess, auditData, iolSchema,
        AuditEventId.<EVENT>.getEventId(), FeatureKey.AT.getFeatureName());
}
```

### Response wrapping — all endpoints
```java
BaseApiResponse<XxxModel> baseResponse =
    ApiResponseBuilderUtil.buildSuccessResponse(responseDto, corrId, featureName);
return responseAssembler.build(baseResponse);
```

---

## Endpoint Registry

> Each endpoint below is the reference pattern. When adding a new one, clone the closest matching entry.

---

### ENDPOINT: CUSTOMER_DETAILS

| Field | Value |
|-------|-------|
| Purpose | Fetch customer details from Account Management API |
| HTTP method | GET |
| EndpointType | `CUSTOMER_DETAILS` |
| AuditEventId | `AuditEventId.CUSTOMER_DETAILS` |
| API target | `accountManagementAPI` |
| Response API class | `CustomerDetailsAccountManagementApiResponse` |
| Response model | `CustomerDetailsResponseModel` |

**File map**:
| Layer | Class | Method |
|-------|-------|--------|
| Controller | `CustomerController` | `getCustomerDetails(IOLSchema, uyiConsentGiven)` |
| Service iface | `CustomerService` | `getCustomerDetails(IOLSchema, String uyiConsentGiven)` |
| Service impl | `CustomerServiceImpl` | `getCustomerDetails(...)` |
| Mapper iface | `CustomerMapper` | `createCustomerRequest(customerId, iolSchema, productCode, featureName)` |
| Mapper impl | `CustomerMapperImpl` | `createCustomerRequest(...)` |
| Strategy | `CustomerDetailsRequestStrategy` | `buildRequest(RequestContext)` |
| Response mapper | `CustomerResponseMapper` | `mapToCustomerDetailsResponse(CustomerDetailsAccountManagementApiData)` |
| Audit helper | `CustomerAuditHelper` | `createCustomerDetailsAuditDataForUyi(uyiConsentGiven)` + `createCustomerDetailsAuditData(ntbValue)` |

**RequestContext**:
```java
RequestContext.builder()
    .featureName(featureName)
    .iolSchema(iolSchema)
    .apiName(ApplicationConstants.ACCOUNTS_MANAGEMENT_API_NAME)
    .apiPrefixErrorName(ErrorConstants.ACCOUNTS_MANAGEMENT_CUSTOMER_API_ERROR_CODE)
    .queryParam(PRODUCT_CODE, productCode)
    .urlParam(CUSTOMER_ID, customerId)
    .parameters(Map.of(CUSTOMER_ID, customerId, PRODUCT_CODE, productCode))
    .build();
```

**Audit CodedValues**:
- `IDENTITY` → decode YES/NO from uyiConsentGiven
- `CREDIT_CHECK` → decode YES/NO
- `DATA_RIGHTS` → decode YES/NO
- `NTB` → decode ntbValue or "false"
- `ERROR_MESSAGE` → on failure only

---

### ENDPOINT: CUSTOMER_ELIGIBILITY

| Field | Value |
|-------|-------|
| Purpose | Check customer eligibility for a product |
| HTTP method | GET |
| EndpointType | `CUSTOMER_ELIGIBILITY` |
| AuditEventId | `AuditEventId.CUSTOMER_ELIGIBILITY` |
| API target | `accountManagementAPI` |
| Response model | `CustomerEligibilityResponse` |

**File map**:
| Layer | Class | Method |
|-------|-------|--------|
| Controller | `CustomerController` | `getCustomerEligibility(...)` |
| Service iface | `EligibilityService` | `getCustomerEligibility(IOLSchema)` |
| Service impl | `EligibilityServiceImpl` | `getCustomerEligibility(...)` |
| Mapper iface | `CustomerMapper` | `createCustomerRequest(iolSchema, productCode, featureName, jointCustomerId, ...)` |
| Strategy | `CustomerEligibilityRequestStrategy` | `buildRequest(RequestContext)` |
| Audit helper | `CustomerAuditHelper` | `createEligibilityAuditDetails(eligibilityOutcome, originalResponse, maxChunkSize, maxChunks)` |

**Audit CodedValues**:
- eligibility outcome status (Optional chain from `BaseApiResponse::status`)
- chunk data from eligibility response
- `ERROR_MESSAGE` → on failure only

---

### ENDPOINT: CUSTOMER_APPLICATION_POST

| Field | Value |
|-------|-------|
| Purpose | Submit a new savings account application |
| HTTP method | POST |
| EndpointType | `CUSTOMER_APPLICATION_POST` |
| AuditEventId | `AuditEventId.CUSTOMER_APPLICATION` |

**File map**:
| Layer | Class | Method |
|-------|-------|--------|
| Controller | `CustomerController` | `createCustomerApplication(...)` |
| Service iface | `CustomerService` | `createCustomerApplication(IOLSchema, request, appRequestContext)` |
| Service impl | `CustomerServiceImpl` | `createCustomerApplication(...)` |
| Mapper iface | `CustomerMapper` | `createCustomerApplicationRequest(iolSchema, appModelRequest, appRequestContext, isCancelRequest=false)` |
| Strategy | `CustomerApplicationPostRequestStrategy` | `buildRequest(RequestContext)` |
| Audit helper | `CustomerAuditHelper` | `createCustomerAppAuditDetails(customerId, productCode, request, userContext, staffNumber)` |
| Helper | `SaveApplicationHelper` | `buildStateChangeResponse(isStateChanged, corrId, featureName)` |

**Audit CodedValues**:
- `CUSTOMER_ID`
- `PRODUCT_CODE`
- `BUSINESS_UNIT_ID`
- `STAFF_NUMBER`
- `LOC_SORT_CODE` → derived via `deriveSortCode(userContext.getBUID())`
- `ACCOUNT_TYPE` → `ACCOUNT_TYPE_JOINT` + `JOINT_CUSTOMER_ID` if joint parties present; else `ACCOUNT_TYPE_SOLE`
- `ERROR_MESSAGE` → on failure only

---

### ENDPOINT: CUSTOMER_APPLICATION_PATCH

| Field | Value |
|-------|-------|
| Purpose | Update/patch an existing application (state transitions) |
| HTTP method | PATCH |
| EndpointType | `CUSTOMER_APPLICATION_PATCH` |
| AuditEventId | `AuditEventId.CUSTOMER_APPLICATION` |

**File map**:
| Layer | Class | Method |
|-------|-------|--------|
| Service impl | `CustomerServiceImpl` | `updateCustomerApplication(...)` |
| Mapper iface | `CustomerMapper` | `createCustomerApplicationRequest(iolSchema, appModelRequest, appRequestContext, isCancelRequest=false)` |
| Strategy | `CustomerApplicationPatchRequestStrategy` | `buildRequest(RequestContext)` |
| Audit helper | `CustomerAuditHelper` | `createCustomerAppAuditDetails(...)` |

> Same audit shape as `CUSTOMER_APPLICATION_POST`.

---

### ENDPOINT: CUSTOMER_PAYMENT_ACCOUNTS

| Field | Value |
|-------|-------|
| Purpose | Retrieve payment accounts linked to a customer |
| HTTP method | GET |
| EndpointType | `CUSTOMER_PAYMENT_ACCOUNTS` |
| AuditEventId | `AuditEventId.CUSTOMER_PAYMENT_ACCOUNTS` |
| Response model | `PaymentAccountsApiResponse` |

**File map**:
| Layer | Class | Method |
|-------|-------|--------|
| Service iface | `CustomerService` | `getCustomerPaymentAccounts(IOLSchema)` |
| Service impl | `CustomerServiceImpl` | `getCustomerPaymentAccounts(...)` |
| Mapper iface | `CustomerMapper` | `createCustomerPaymentAccountsRequest(customerId, iolSchema, featureName)` |
| Strategy | `CustomerPaymentAccountsRequestStrategy` | `buildRequest(RequestContext)` |
| Helper | `PaymentAccountHelper` | (payment-specific logic) |

---

### ENDPOINT: CUSTOMER_CANCELLATION

| Field | Value |
|-------|-------|
| Purpose | Cancel an existing application |
| HTTP method | POST or PATCH |
| EndpointType | `CUSTOMER_CANCELLATION` |
| AuditEventId | `AuditEventId.CUSTOMER_CANCELLATION` |

**File map**:
| Layer | Class | Method |
|-------|-------|--------|
| Mapper iface | `CustomerMapper` | `createCustomerApplicationRequest(iolSchema, appModelRequest, appRequestContext, isCancelRequest=true)` |
| Audit helper | `CustomerAuditHelper` | `createCustomerCancellationAuditData(existingApplicationId)` |

**Audit CodedValues**:
- `CANCEL_APPLICATION` → decode YES
- `APPLICATION_ID` → decode existingApplicationId

---

## New Endpoint Checklist

> Give Claude this prompt: **"Add a new endpoint called `<NAME>` which does `<description>`. Follow the CLAUDE.md checklist."**
> Claude will execute all 10 steps below in order.

### Step 1 — EndpointType enum
```java
// Add to EndpointType.java
NEW_ENDPOINT_NAME
```

### Step 2 — Request Strategy
Create `NewEndpointNameRequestStrategy.java` in `customer/request/strategy/`:
```java
@Component
public class NewEndpointNameRequestStrategy implements RequestStrategy {

    private final UrlBuilderService urlBuilderService;
    private final RequestBuilderHelper requestBuilderHelper;

    public NewEndpointNameRequestStrategy(UrlBuilderService urlBuilderService,
                                          RequestBuilderHelper requestBuilderHelper) {
        this.urlBuilderService = urlBuilderService;
        this.requestBuilderHelper = requestBuilderHelper;
    }

    @Override
    public RestConnectorRequest buildRequest(RequestContext context) {
        LogUtil.info(getClass(), message: "BUILD_NEW_ENDPOINT_REQUEST_START - Feature: %s",
            context.getFeatureName());
        var url = urlBuilderService.buildUrl(context, getEndpointType());
        var request = requestBuilderHelper.createRequest(getEndpointType(), url, context,
            null); // null for GET; supply body for POST/PATCH
        LogUtil.info(getClass(), message: "BUILD_NEW_ENDPOINT_REQUEST_SUCCESS - EndpointType: %s",
            getEndpointType());
        return request;
    }

    @Override
    public EndpointType getEndpointType() { return EndpointType.NEW_ENDPOINT_NAME; }
}
```

### Step 3 — CustomerMapper interface
```java
/**
 * Builds request for <description>.
 * @param customerId  non-blank customer identifier
 * @param iolSchema   non-null invocation context
 * @param featureName feature name for observability
 */
RestConnectorRequest createNewEndpointRequest(String customerId, IOLSchema iolSchema,
                                               String featureName);
```

### Step 4 — CustomerMapperImpl
```java
@Override
public RestConnectorRequest createNewEndpointRequest(String customerId, IOLSchema iolSchema,
                                                      String featureName) {
    LogUtil.info(getClass(),
        message: "NEW_ENDPOINT_REQUEST_CREATION_START - CustomerId: %s, Feature: %s",
        customerId, featureName);

    var context = RequestContext.builder()
        .featureName(featureName)
        .iolSchema(iolSchema)
        .apiName(ApplicationConstants.ACCOUNTS_MANAGEMENT_API_NAME)
        .apiPrefixErrorName(ErrorConstants.ACCOUNTS_MANAGEMENT_CUSTOMER_API_ERROR_CODE)
        .queryParam(PRODUCT_CODE, productCode)
        .urlParam(CUSTOMER_ID, customerId)
        .parameters(Map.of(CUSTOMER_ID, customerId))
        .build();

    var request = customerRequestFactory.buildRequest(EndpointType.NEW_ENDPOINT_NAME, context);

    LogUtil.info(getClass(),
        message: "NEW_ENDPOINT_REQUEST_CREATION_SUCCESS - endpoint: %s",
        EndpointType.NEW_ENDPOINT_NAME);
    return request;
}
```

### Step 5 — CustomerAuditHelper (new static method)
```java
public static List<CodedValue> createNewEndpointAuditData(String someValue) {
    var auditData = new ArrayList<CodedValue>();
    auditData.add(CodedValue.builder()
        .code(SOME_CODE)
        .decode(someValue != null ? someValue : "")
        .build());
    // add more CodedValues as needed
    return auditData;
}
```

### Step 6 — CustomerResponseMapper (if new response shape)
```java
NewEndpointResponseModel mapToNewEndpointResponse(NewEndpointApiData apiData);
```

### Step 7 — Service interface
```java
Response<BaseApiResponse<NewEndpointResponseModel>> newEndpointMethod(IOLSchema iolSchema,
                                                                        String someParam);
```

### Step 8 — Service implementation
```java
@Override
public Response<BaseApiResponse<NewEndpointResponseModel>> newEndpointMethod(
        IOLSchema iolSchema, String someParam) {

    String corrId = SavingsAccOpenUtil.getCorrelationIdFromContext(iolSchema);
    LogUtil.info(getClass(),
        message: "Outcome=START | method=newEndpointMethod | feature=%s | corrId=%s",
        FeatureKey.AT.getFeatureName(), corrId);

    var responseAssembler = Response.<BaseApiResponse<NewEndpointResponseModel>>assemble();
    List<CodedValue> auditData = new ArrayList<>();
    boolean isSuccess = false;

    try {
        savingsAccOpenUtil.validateIOLSchemaNotNull(iolSchema, FeatureKey.AT.getFeatureName());
        String customerId = savingsAccOpenUtil.getCustomerIdFromContext(
            iolSchema.getCustomerContext(), FeatureKey.AT.getFeatureName());

        auditData = CustomerAuditHelper.createNewEndpointAuditData(someParam);

        var response = apiServiceManager.callRestApi(
            accountManagementAPI,
            customerMapper.createNewEndpointRequest(customerId, iolSchema,
                FeatureKey.AT.getFeatureName()),
            NewEndpointApiResponse.class,
            FeatureKey.AT.getFeatureName()
        );

        var responseDto = customerResponseMapper.mapToNewEndpointResponse(response.data());
        var baseResponse = ApiResponseBuilderUtil.buildSuccessResponse(
            responseDto, corrId, FeatureKey.AT.getFeatureName());

        LogUtil.info(getClass(),
            message: "Outcome=SUCCESS | method=newEndpointMethod | corrId=%s", corrId);
        isSuccess = true;
        return responseAssembler.build(baseResponse);

    } catch (SavingsAccOpenEpsException ex) {
        isSuccess = false;
        CustomerAuditHelper.addErrorDetails(auditData, ex.getMessage());
        throw ex;
    } catch (Exception ex) {
        isSuccess = false;
        LogUtil.error(getClass(),
            message: "Outcome=FAILURE | method=newEndpointMethod | corrId=%s | message=%s",
            ex, corrId, ex.getMessage());
        CustomerAuditHelper.addErrorDetails(auditData, ex.getMessage());
        throw new SavingsAccOpenEpsException(
            ErrorsEnum.EPS_SYS_ERR.getErrorCode(),
            ErrorsEnum.EPS_SYS_ERR.getErrorDescription(),
            ErrorsEnum.EPS_SYS_ERR.getHttpStatusCode(),
            FeatureKey.AT.getFeatureName()
        );
    } finally {
        logAuditEntry(isSuccess, auditData, iolSchema,
            AuditEventId.NEW_ENDPOINT.getEventId(), FeatureKey.AT.getFeatureName());
    }
}
```

### Step 9 — Controller
```java
// Add appropriate @GetMapping / @PostMapping / @PatchMapping
public ResponseEntity<Response<BaseApiResponse<NewEndpointResponseModel>>> newEndpoint(
        IOLSchema iolSchema, ...) {
    return ResponseEntity.ok(customerService.newEndpointMethod(iolSchema, someParam));
}
```

### Step 10 — Verify (always run after implementing)
1. Build the project — must compile with zero errors
2. Confirm `RequestFactory` was **NOT modified**
3. Run the app — check startup logs for: `CUSTOMER_REQUEST_FACTORY_INITIALIZATION_SUCCESS - Registered strategies: [... NEW_ENDPOINT_NAME ...]`
4. Write unit tests for: Strategy class, Mapper method, Service method (success + failure + audit paths)

---

## Domain Vocabulary

| Term | Meaning |
|------|---------|
| IOLSchema | Context carrier — auth, customer, process data |
| UYI | Use Your Information consent |
| NTB | New To Bank |
| corrId | Correlation ID for distributed tracing |
| CodedValue | Key-value audit trail entry |
| FeatureKey.AT | Feature key constant for this service |
| JOINT / SOLE | Account type |
| TIAA | External contract/schema |
| MCA | Mobile Channel API |
| EPS | Electronic Payment Services |
| SAVEAOP | Jira ticket prefix |

---

## Hard Rules

1. **Never modify `RequestFactory`** — Spring auto-discovers strategies
2. **Never access `iolSchema` fields directly** — use `SavingsAccOpenUtil` helpers
3. **`logAuditEntry` must run in `finally`** — on both success and failure
4. **Utility classes must be non-instantiable** — throw `UnsupportedOperationException` in private constructor
5. **All strategy/service fields must be `final`**
6. **Always catch `SavingsAccOpenEpsException` before `Exception`**
7. **Never log sensitive data at INFO** — customerId, accountNumber are DEBUG only
