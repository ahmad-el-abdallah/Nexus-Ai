"""Departments (all 20), reporting lines and a director for every department.

Revision ID: 0003_departments
Revises: 0002_employees
Create Date: 2026-10-08
"""

import random
import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_departments"
down_revision: str | None = "0002_employees"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# key, name, colour, office room, description, responsibilities, roles (director first)
DEPARTMENTS = [
    ("executive", "Executive Management", "#a78bfa", "executive",
     "Turns the owner's instructions into strategy and coordinates every department. Never authorises sensitive external actions without the owner.",
     ["Interpret owner instructions", "Create strategic plans", "Delegate projects", "Coordinate departments", "Evaluate results", "Identify operational risks", "Request required approvals", "Generate executive summaries"],
     ["Chief Executive Officer", "Chief Operating Officer", "Chief Strategy Officer", "Executive Assistant"]),
    ("project-management", "Project Management", "#60a5fa", None,
     "Plans projects, breaks them into tasks, tracks dependencies and keeps delivery on schedule.",
     ["Create project plans", "Break projects into tasks", "Assign responsible teams", "Track dependencies", "Monitor deadlines", "Identify blockers", "Manage delivery milestones", "Produce progress reports"],
     ["Project Director", "Project Manager", "Task Coordinator", "Delivery Manager"]),
    ("engineering", "Software Engineering", "#22d3ee", "engineering",
     "Builds and maintains software. All command execution runs under explicit sandbox and permission policies.",
     ["Develop applications", "Write code", "Review pull requests", "Fix bugs", "Create APIs", "Build internal tools", "Prepare deployment configurations", "Maintain documentation"],
     ["Chief Technology Officer", "Software Architect", "Frontend Developer", "Backend Developer", "AI Engineer", "DevOps Engineer"]),
    ("quality-assurance", "Quality Assurance", "#2dd4bf", None,
     "Independently verifies deliverables, separate from the agents who produced them.",
     ["Write tests", "Run tests", "Review functionality", "Identify regressions", "Verify deliverables", "Report defects", "Request corrections"],
     ["QA Director", "Test Engineer", "Automation Engineer", "Security Testing Specialist"]),
    ("design", "Design & Creative", "#e879f9", None,
     "Designs interfaces, brands and visual assets. Reports a clear limitation when no image tool is available rather than pretending.",
     ["Design interfaces", "Create branding concepts", "Prepare design specifications", "Generate visual assets through authorised tools", "Review consistency", "Produce design deliverables"],
     ["Creative Director", "UI/UX Designer", "Brand Designer", "Graphic Designer", "3D Artist"]),
    ("marketing", "Marketing", "#f472b6", "marketing",
     "Analyses markets and plans campaigns, always separating real research from model-generated hypotheses.",
     ["Conduct market analysis", "Identify target customers", "Build marketing strategies", "Draft advertisements", "Create campaign plans", "Analyse campaign performance", "Produce content calendars", "Research trends", "Recommend acquisition strategies"],
     ["Chief Marketing Officer", "Marketing Strategist", "Social Media Manager", "SEO Specialist", "Content Strategist", "Advertising Specialist", "Growth Specialist"]),
    ("sales", "Sales", "#fbbf24", "sales",
     "Researches prospects and drafts outreach and proposals. Never invents contact details; outreach follows compliance rules.",
     ["Research potential customers", "Qualify leads", "Create outreach drafts", "Prepare sales scripts", "Track pipeline stages", "Generate proposals", "Summarise customer interactions", "Analyse conversion rates"],
     ["Sales Director", "Sales Development Representative", "Account Executive", "Lead Research Specialist", "Sales Operations Analyst"]),
    ("data", "Data & Business Intelligence", "#38bdf8", None,
     "Cleans and analyses data. Every important recommendation references its supporting data.",
     ["Clean data", "Validate datasets", "Build reports", "Analyse KPIs", "Identify trends", "Detect anomalies", "Produce charts", "Suggest evidence-based decisions"],
     ["Chief Data Officer", "Data Analyst", "Business Intelligence Analyst", "Data Engineer", "Analytics Specialist"]),
    ("research", "Market Research & Innovation", "#a3e635", None,
     "Studies markets and competitors using real sources. Never fabricates current market data.",
     ["Study markets", "Research competitors", "Identify unmet needs", "Discover product opportunities", "Monitor authorised public sources", "Evaluate business opportunities"],
     ["Research Director", "Market Researcher", "Trend Analyst", "Competitor Analyst", "Innovation Specialist"]),
    ("finance", "Finance", "#4ade80", None,
     "Tracks spending, costs and budgets, including AI usage costs. Never makes payments or transfers automatically.",
     ["Track operational spending", "Calculate project costs", "Forecast budgets", "Review expenses", "Generate financial summaries", "Monitor AI usage costs"],
     ["Chief Financial Officer", "Financial Analyst", "Budget Controller", "Accounting Assistant"]),
    ("human-resources", "Human Resources", "#fb7185", None,
     "Manages AI employee profiles and configurations — these are AI agents, not people.",
     ["Manage AI employee profiles", "Evaluate performance", "Recommend role assignments", "Identify skill gaps", "Maintain organisational charts", "Propose training instructions", "Recommend employee reconfiguration"],
     ["HR Director", "Talent Planning Agent", "Employee Performance Analyst", "Training Coordinator"]),
    ("operations", "Operations", "#fb923c", None,
     "Improves processes and workflows and reduces redundant AI calls.",
     ["Improve processes", "Monitor workflows", "Detect bottlenecks", "Coordinate handoffs", "Reduce redundant AI calls", "Optimise task execution"],
     ["Head of Operations", "Operations Manager", "Process Improvement Specialist", "Workflow Automation Specialist"]),
    ("customer-support", "Customer Support", "#34d399", None,
     "Prepares customer responses and escalates sensitive cases. External replies follow the approval policy.",
     ["Prepare customer responses", "Classify support requests", "Summarise tickets", "Identify recurring issues", "Escalate sensitive cases", "Maintain support knowledge"],
     ["Customer Support Director", "Support Agent", "Technical Support Specialist", "Customer Experience Analyst"]),
    ("legal", "Legal & Compliance", "#94a3b8", None,
     "Flags legal and privacy issues for review. These are assistants, not licensed legal professionals; high-stakes decisions need qualified human review.",
     ["Identify legal issues requiring review", "Research regulations when sources are available", "Maintain policy checklists", "Flag privacy risks", "Review draft contracts for potential issues"],
     ["Head of Legal & Compliance", "Compliance Analyst", "Policy Research Agent", "Legal Research Assistant", "Privacy Coordinator"]),
    ("security", "Cybersecurity", "#f87171", None,
     "Reviews application security, access controls and suspicious tool activity.",
     ["Review application security", "Monitor authorisation failures", "Audit access controls", "Flag suspicious tool activity", "Review secure configurations", "Maintain security checklists"],
     ["Security Director", "Security Analyst", "Access Control Specialist", "Security Auditor"]),
    ("public-relations", "Public Relations", "#c084fc", None,
     "Drafts announcements and communication plans. Publishing always needs the owner's approval.",
     ["Draft official announcements", "Prepare company communications", "Review public messaging", "Create communication plans"],
     ["PR Director", "Communications Specialist", "Reputation Analyst"]),
    ("product", "Product Management", "#818cf8", None,
     "Defines requirements and roadmaps and coordinates design and engineering.",
     ["Define product requirements", "Prioritise features", "Maintain roadmaps", "Analyse customer feedback", "Coordinate design and engineering"],
     ["Chief Product Officer", "Product Manager", "Product Researcher", "Product Operations Agent"]),
    ("procurement", "Procurement", "#facc15", None,
     "Researches and compares vendors and drafts purchase recommendations. Never purchases automatically.",
     ["Research services", "Compare vendors", "Evaluate pricing", "Identify procurement risks", "Draft purchase recommendations"],
     ["Procurement Manager", "Vendor Research Specialist", "Cost Comparison Analyst"]),
    ("it", "IT & Internal Systems", "#67e8f9", None,
     "Keeps the company's systems, configuration and tool connections healthy.",
     ["Manage application configuration", "Monitor technical systems", "Maintain tool connections", "Diagnose system errors", "Report service outages"],
     ["IT Manager", "Systems Administrator Agent", "Integration Specialist"]),
    ("knowledge", "Knowledge Management", "#d6b46a", None,
     "Organises internal documents and keeps knowledge searchable to avoid repeated research.",
     ["Organise internal documents", "Maintain searchable knowledge", "Manage documentation versions", "Retrieve relevant project information", "Reduce repeated research"],
     ["Knowledge Director", "Documentation Specialist", "Information Retrieval Agent"]),
]

# Directors for the departments added in this stage (no desk yet: the building
# has offices for executive, sales, marketing and engineering only).
NEW_DIRECTORS = {
    "project-management": "Grace Liu",
    "quality-assurance": "Tomás Herrera",
    "design": "Nadia Petrova",
    "data": "Rahul Mehta",
    "research": "Chloé Dubois",
    "finance": "Ibrahim Saleh",
    "human-resources": "Mei Tanaka",
    "operations": "Ethan Brooks",
    "customer-support": "Fatima Zahra",
    "legal": "Daniel Cohen",
    "security": "Viktor Novak",
    "public-relations": "Lina Farouk",
    "product": "Ana Costa",
    "procurement": "Peter Walsh",
    "it": "Arjun Rao",
    "knowledge": "Yara Nasser",
}
EXISTING_DIRECTOR_ROLES = {
    "executive": "Chief Executive Officer",
    "sales": "Sales Director",
    "marketing": "Chief Marketing Officer",
    "engineering": "Chief Technology Officer",
}


def upgrade() -> None:
    departments = op.create_table(
        "departments",
        sa.Column("key", sa.String(length=40), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("responsibilities", sa.JSON(), nullable=False),
        sa.Column("roles", sa.JSON(), nullable=False),
        sa.Column("color", sa.String(length=9), nullable=False),
        sa.Column("room_id", sa.String(length=40), nullable=True),
        sa.Column("director_id", sa.String(length=32), nullable=True),
        sa.Column("max_concurrent_tasks", sa.Integer(), nullable=False),
        sa.Column("daily_request_budget", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["director_id"], ["employees.id"], name=op.f("fk_departments_director_id_employees"), ondelete="SET NULL", use_alter=True
        ),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_departments")),
    )
    op.bulk_insert(
        departments,
        [
            {
                "key": key,
                "position": i + 1,
                "name": name,
                "description": description,
                "responsibilities": responsibilities,
                "roles": roles,
                "color": color,
                "room_id": room,
                "director_id": None,
                "max_concurrent_tasks": 2,
                "daily_request_budget": 200,
            }
            for i, (key, name, color, room, description, responsibilities, roles) in enumerate(DEPARTMENTS)
        ],
    )

    with op.batch_alter_table("employees") as batch:
        batch.add_column(sa.Column("supervisor_id", sa.String(length=32), nullable=True))
        batch.create_foreign_key(op.f("fk_employees_supervisor_id_employees"), "employees", ["supervisor_id"], ["id"], ondelete="SET NULL")
        batch.create_foreign_key(op.f("fk_employees_department_departments"), "departments", ["department"], ["key"])

    conn = op.get_bind()
    employees = sa.table(
        "employees",
        sa.column("id", sa.String),
        sa.column("name", sa.String),
        sa.column("role", sa.String),
        sa.column("department", sa.String),
        sa.column("seniority", sa.String),
        sa.column("desk_id", sa.String),
        sa.column("avatar_seed", sa.Integer),
        sa.column("status", sa.String),
        sa.column("supervisor_id", sa.String),
    )
    dept_table = sa.table("departments", sa.column("key", sa.String), sa.column("director_id", sa.String), sa.column("roles", sa.JSON))
    roles_by_key = {d[0]: d[6] for d in DEPARTMENTS}

    rng = random.Random(4)
    new_rows = [
        {
            "id": f"emp_{uuid.uuid4().hex[:12]}",
            "name": name,
            "role": roles_by_key[key][0],
            "department": key,
            "seniority": "director",
            "desk_id": None,
            "avatar_seed": 500 + rng.randint(1, 9999),
            "status": "idle",
            "supervisor_id": None,
        }
        for key, name in NEW_DIRECTORS.items()
    ]
    op.bulk_insert(employees, new_rows)

    rows = conn.execute(sa.select(employees.c.id, employees.c.role, employees.c.department)).all()
    directors: dict[str, str] = {}
    for emp_id, role, dept in rows:
        if roles_by_key[dept][0] == role:
            directors[dept] = emp_id
    for dept, emp_id in directors.items():
        conn.execute(dept_table.update().where(dept_table.c.key == dept).values(director_id=emp_id))

    # Reporting lines: CEO at the top, directors report to the CEO, staff to their director.
    ceo = directors["executive"]
    for emp_id, role, dept in rows:
        if emp_id == ceo:
            continue
        supervisor = ceo if directors.get(dept) == emp_id else directors.get(dept, ceo)
        conn.execute(employees.update().where(employees.c.id == emp_id).values(supervisor_id=supervisor))


def downgrade() -> None:
    conn = op.get_bind()
    employees = sa.table("employees", sa.column("department", sa.String))
    conn.execute(employees.delete().where(employees.c.department.notin_(["executive", "sales", "marketing", "engineering"])))
    with op.batch_alter_table("employees") as batch:
        batch.drop_constraint(op.f("fk_employees_department_departments"), type_="foreignkey")
        batch.drop_constraint(op.f("fk_employees_supervisor_id_employees"), type_="foreignkey")
        batch.drop_column("supervisor_id")
    op.drop_table("departments")
