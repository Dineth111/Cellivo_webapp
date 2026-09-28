# Cellivo

**Cloud-Based POS & Business Management Platform for Mobile Phone Retailers and Repair Centres**

Cellivo is a multi-tenant cloud-based business management and Point of Sale (POS) platform designed for mobile phone retailers and repair centres.

The system integrates sales, inventory, IMEI/serial number tracking, purchasing, repairs, customers, credit and installments, finance, staff management, multi-branch operations, reporting, subscriptions, and platform administration into a single system.

---

## 🚀 Project Overview

Cellivo provides a centralized platform for managing day-to-day operations of mobile phone shops and repair centres.

The system consists of four main areas:

* **Public Website**
* **Account & Billing Portal**
* **Shop Application**
* **Platform Administration Dashboard**

The platform supports multiple shops/tenants while maintaining tenant-level data isolation and role-based access control.

---

## 🎯 Main Objectives

* Manage mobile phone shop sales and POS operations.
* Track products, stock, IMEI numbers, and serial numbers.
* Manage suppliers and purchasing.
* Manage mobile phone repair operations.
* Maintain customer information and transaction history.
* Support credit sales and installment payments.
* Manage shop finances and cash operations.
* Manage staff, commissions, attendance, and payroll.
* Support multiple branches and stock transfers.
* Provide business dashboards and reports.
* Manage subscriptions and billing.
* Provide platform-level administration.

---

## 🏗️ System Modules

### 1. Account & Security

* User registration
* Email verification
* Login and logout
* Password reset
* Two-factor authentication
* Session management
* User management
* Roles and permissions
* Audit logging
* Subscription management
* Trial management
* Billing and payments

**Developer:** DEV 01

---

### 2. POS & Customer Management

* POS billing
* Product search
* Barcode scanning
* IMEI selection
* Shopping cart
* Discounts
* Taxes
* Multiple payment methods
* Split payments
* Invoice generation
* Receipt generation
* Sales history
* Hold/resume sales
* Quotations
* Returns and exchanges
* Trade-ins
* Wholesale sales
* Credit sales
* Installments
* Customer management
* Customer history
* Loyalty management

**Developer:** DEV 02

---

### 3. Inventory, IMEI & Purchasing

* Product management
* Categories
* Brands
* Models
* Product variants
* Product attributes
* Stock management
* Stock movements
* Stock adjustments
* Stock counting
* Low-stock alerts
* Barcode labels
* IMEI/serial number tracking
* IMEI history
* Supplier management
* Purchase orders
* Goods Received Notes (GRN)
* Supplier bills
* Purchase payments
* Purchase returns
* Branch management
* Stock transfers

**Developer:** DEV 03

---

### 4. Repairs, Finance & Staff

#### Repair Management

* Repair ticket creation
* Customer and device information
* IMEI/device tracking
* Fault description
* Device photos
* Estimated repair cost
* Advance payments
* Promised completion date
* Technician assignment
* Repair status tracking
* Parts usage
* Repair invoicing
* Warranty management
* Customer notification
* Public repair-status tracking

#### Finance

* Cash drawer
* Opening cash float
* Cash in/out
* Expenses
* Bank accounts
* Bank transfers
* Cheque management
* Customer payments
* Supplier payments
* Financial reconciliation
* Day-end reporting

#### Staff & Payroll

* Staff management
* Salary management
* Commission management
* Attendance
* Shift management
* Clock in/out
* Salary advances
* Allowances
* Deductions
* Payroll
* Payslips

**Developer:** DEV 04

---

### 5. Dashboard, Reports, Integrations & Platform Admin

#### Dashboard

* Revenue
* Profit
* Profit margin
* Orders
* Stock information
* Low-stock alerts
* Repair queue
* Ready-for-pickup repairs
* Revenue vs profit
* Latest sales
* Customer balances
* Cheques
* Top products
* Staff performance
* Branch performance

#### Reports

* Sales reports
* Profit reports
* Inventory reports
* Repair reports
* Customer reports
* Financial reports
* KPI reports
* PDF/Excel exports

#### Platform Administration

* Platform dashboard
* Tenant management
* Tenant details
* Tenant activation/suspension
* Subscription plans
* Pricing management
* Payment management
* Refund management
* Manual payments
* Coupon management
* SMS credit management
* Platform audit information

#### Integrations

* SMS
* Email
* Payment gateway
* WooCommerce
* Printing
* Barcode scanners
* WhatsApp
* Document/invoice templates

**Developer:** DEV 05

---

# 👨‍💻 Development Team Structure

The project is divided into five main development components.

| Developer | Component          | Main Responsibilities                                             |
| --------- | ------------------ | ----------------------------------------------------------------- |
| DEV 01    | Account & Security | Authentication, users, roles, permissions, subscriptions, billing |
| DEV 02    | POS & CRM          | POS, sales, invoices, customers, credit, installments, loyalty    |
| DEV 03    | Inventory          | Products, stock, IMEI, purchasing, suppliers, branches            |
| DEV 04    | Operations         | Repairs, finance, staff, commissions, payroll                     |
| DEV 05    | Analytics & Admin  | Dashboard, reports, integrations, platform administration         |

---

# 🧩 System Architecture

```text
                         ┌───────────────────────┐
                         │      Public Website   │
                         └───────────┬───────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │ Account & Billing     │
                         │       Portal          │
                         └───────────┬───────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────┐
│                         CELLIVO PLATFORM                     │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │    Auth    │  │    POS     │  │ Inventory  │             │
│  └────────────┘  └────────────┘  └────────────┘             │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │  Repairs   │  │  Finance   │  │    HR      │             │
│  └────────────┘  └────────────┘  └────────────┘             │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │   CRM      │  │  Reports   │  │   Admin    │             │
│  └────────────┘  └────────────┘  └────────────┘             │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │      Database       │
                    │ Multi-Tenant Data   │
                    └─────────────────────┘
```

---

# 📁 Recommended Repository Structure

```text
cellivo/
│
├── frontend/
│   ├── auth/
│   ├── pos/
│   ├── inventory/
│   ├── repairs/
│   ├── finance/
│   ├── reports/
│   └── admin/
│
├── backend/
│   ├── auth/
│   ├── pos/
│   ├── inventory/
│   ├── repairs/
│   ├── finance/
│   ├── reports/
│   └── admin/
│
├── database/
│   ├── migrations/
│   ├── seeders/
│   └── schemas/
│
├── shared/
│   ├── constants/
│   ├── types/
│   ├── validators/
│   └── utilities/
│
├── docs/
│   ├── architecture/
│   ├── api/
│   ├── database/
│   └── requirements/
│
├── tests/
│
├── .env.example
├── .gitignore
├── README.md
└── LICENSE
```

---

# 🔐 Multi-Tenant Architecture

Cellivo is designed as a multi-tenant platform.

Each shop/tenant must have isolated business data.

Core entities should contain the required tenant/branch relationship where applicable.

Important shared entities include:

```text
Tenant
User
Role
Permission
Branch
Product
Customer
Supplier
Invoice
Payment
AuditLog
```

All developers must follow the agreed tenant and branch isolation rules when creating APIs and database queries.

---

# 🔑 Role-Based Access Control

Cellivo uses role-based access control.

Example roles include:

* Owner
* Branch Manager
* Cashier
* Technician
* Accountant
* Platform Super Admin

Permissions should be checked at the API/backend level rather than relying only on frontend restrictions.

---

# 🔄 Core Business Flow

### Sales Flow

```text
Product Search
      ↓
Barcode / IMEI Selection
      ↓
Add to Cart
      ↓
Apply Discount / Tax
      ↓
Select Payment Method
      ↓
Complete Sale
      ↓
Generate Invoice / Receipt
      ↓
Update Inventory
      ↓
Record Payment
```

### Repair Flow

```text
Create Repair Ticket
        ↓
Customer + Device Details
        ↓
Assign Technician
        ↓
Diagnosis
        ↓
Parts / Repair Work
        ↓
Repair Completion
        ↓
Quality Check
        ↓
Invoice
        ↓
Payment
        ↓
Delivered to Customer
```

### Purchase Flow

```text
Purchase Order
      ↓
Supplier
      ↓
Goods Received
      ↓
Stock Update
      ↓
Supplier Bill
      ↓
Payment
      ↓
Inventory Updated
```

---

# 🔌 API Structure

Recommended API grouping:

```text
/api/auth
/api/users
/api/roles
/api/permissions

/api/products
/api/inventory
/api/imei

/api/customers
/api/sales
/api/invoices
/api/payments
/api/returns

/api/suppliers
/api/purchases
/api/grn

/api/repairs
/api/technicians

/api/finance
/api/banks
/api/expenses

/api/staff
/api/payroll

/api/branches
/api/transfers

/api/reports
/api/dashboard

/api/subscriptions
/api/billing

/api/admin
```

---

# 🌿 Git Branching Strategy

Each developer should work on their own feature branches.

```text
main
 │
 ├── develop
 │
 ├── feature/dev01-auth
 ├── feature/dev02-pos
 ├── feature/dev03-inventory
 ├── feature/dev04-repairs
 └── feature/dev05-dashboard
```

### Branch Naming

```text
feature/dev01-auth
feature/dev01-users
feature/dev02-pos
feature/dev02-customers
feature/dev03-inventory
feature/dev03-purchasing
feature/dev04-repairs
feature/dev04-finance
feature/dev05-reports
feature/dev05-admin
```

---

# 📌 Development Rules

All developers must follow these rules:

1. Do not directly modify another developer's component without discussion.
2. Follow the FRS and SRS requirements.
3. Follow the agreed database structure.
4. Maintain tenant isolation.
5. Apply authentication and authorization to protected APIs.
6. Validate all user inputs.
7. Use consistent API response formats.
8. Handle errors properly.
9. Add audit logging where required.
10. Write meaningful commit messages.
11. Test features before creating a pull request.
12. Update documentation when introducing a new API or major feature.

---

# 📝 Commit Convention

Use clear commit messages.

Examples:

```text
feat: add user registration
feat: implement POS cart
feat: add IMEI inventory tracking
feat: implement repair ticket creation
feat: add sales dashboard
```

For bug fixes:

```text
fix: resolve invoice calculation issue
fix: correct stock quantity update
fix: repair status transition error
```

For documentation:

```text
docs: update API documentation
docs: add inventory setup guide
```

---

# 🔀 Pull Request Process

Before creating a Pull Request:

```text
1. Pull latest develop branch
2. Resolve conflicts
3. Run the application
4. Test your feature
5. Run available automated tests
6. Check database migrations
7. Check API validation
8. Create Pull Request
```

Pull Requests should include:

* What was implemented
* Related module
* Database changes
* API changes
* Testing performed
* Screenshots where applicable

---

# 🗄️ Database Guidelines

Database changes should be handled through migrations.

Developers should avoid manually changing the shared production database.

Example:

```text
database/
├── migrations/
├── seeders/
└── schemas/
```

When adding a new entity:

```text
1. Create migration
2. Create model/entity
3. Create repository/service
4. Create API
5. Add validation
6. Add tests
7. Update documentation
```

---

# 🧪 Testing

Testing should cover:

### Unit Testing

* Business logic
* Calculations
* Validation
* Services

### API Testing

* Authentication
* Authorization
* CRUD operations
* Error handling
* Tenant isolation

### Integration Testing

* POS + Inventory
* POS + Customer
* POS + Finance
* Repairs + Inventory
* Repairs + Customers
* Purchasing + Inventory
* Branches + Inventory

### User Acceptance Testing

The completed system should be tested against the functional requirements defined in the FRS/SRS.

---

# 🚦 Development Priority

### Phase 1 – Foundation

```text
Authentication
Tenant Management
Database Structure
Roles & Permissions
Branch Structure
Common API Standards
```

### Phase 2 – Core Business

```text
Products
Inventory
IMEI
Customers
POS
Sales
Purchasing
```

### Phase 3 – Operations

```text
Repairs
Finance
Credit
Installments
Staff
Payroll
Branches
```

### Phase 4 – Management

```text
Dashboard
Reports
Platform Admin
Subscriptions
Billing
```

### Phase 5 – Integrations & Quality

```text
SMS
Email
Payment Gateway
WooCommerce
WhatsApp
Printing
Testing
Security
Performance
Deployment
```

---

# 📅 Suggested Development Timeline

| Week    | Main Activities                                                       |
| ------- | --------------------------------------------------------------------- |
| Week 01 | Architecture, database planning, Git setup, authentication foundation |
| Week 02 | Users/roles, POS, inventory, repairs, dashboard foundation            |
| Week 03 | Sales, IMEI, purchasing, repair workflow, customer management         |
| Week 04 | POS + inventory integration, finance, staff                           |
| Week 05 | Branches, reports, credit/installments, payroll                       |
| Week 06 | Platform admin, subscriptions, billing, integrations                  |
| Week 07 | Integration testing, security testing, bug fixing                     |
| Week 08 | UAT, performance testing, documentation, deployment                   |

---

# 👥 Team Responsibilities

Every developer is responsible for:

* Understanding their assigned FRS/SRS requirements.
* Designing their module correctly.
* Developing frontend and backend components assigned to them.
* Creating required database migrations.
* Writing API documentation.
* Testing their implementation.
* Integrating with other modules.
* Fixing bugs related to their component.
* Maintaining clean and readable code.

---

# 📚 Documentation

Project documentation should be maintained inside:

```text
docs/
├── architecture/
├── api/
├── database/
├── requirements/
└── deployment/
```

The FRS and SRS should be treated as the primary functional and software requirement references for development.

---

# 🔗 Component Dependencies

```text
                    DEV 01
             Authentication & Access
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
       DEV 02       DEV 03      DEV 04
        POS        Inventory    Operations
          │           │           │
          └───────────┼───────────┘
                      ▼
                    DEV 05
             Dashboard / Reports
                / Admin / APIs
```

### Important Integration Points

**DEV 02 ↔ DEV 03**

POS requires product, inventory, and IMEI information.

**DEV 02 ↔ DEV 04**

Sales and customer payments affect finance.

**DEV 03 ↔ DEV 04**

Repair parts and stock usage affect inventory.

**DEV 01 ↔ All Developers**

All protected modules depend on authentication, users, roles, permissions, tenant, and branch context.

**DEV 05 ↔ All Developers**

Dashboard and reports consume data from the core modules.

---

# 🛡️ Security

The system should implement:

* Authentication
* Authorization
* Role-based access control
* Tenant data isolation
* Branch-level access where required
* Secure password handling
* Session management
* Two-factor authentication
* Input validation
* API authorization
* Audit logging
* Secure payment handling
* Protection of sensitive customer/bu
