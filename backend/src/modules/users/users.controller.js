import User from './User.model.js';
import * as svc from './users.service.js';
import { str, escapeRegex, pageParams } from '../../core/validate.js';

export const list = async (req, res) => {
  const filter = {};
  const search = str(req.query.search);
  if (search) {
    const re = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ name: re }, { email: re }, { phone: re }];
  }
  if (req.query.status === 'active') filter.isActive = true;
  if (req.query.status === 'inactive') filter.isActive = false;
  const { page, limit, skip } = pageParams(req.query);
  const [data, total] = await Promise.all([
    User.find(filter).populate('roleId', 'name key').sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  res.json({ success: true, page, limit, total, data });
};

export const get = async (req, res) => res.json({ success: true, data: await svc.getUser(req.params.id) });

export const create = async (req, res) => {
  const { user } = await svc.inviteUser(req.body);
  res.status(201).json({ success: true, message: 'Invitation created', data: user });
};

export const update = async (req, res) => res.json({ success: true, data: await svc.updateUser(req.params.id, req.body) });

export const deactivate = async (req, res) => res.json({ success: true, data: await svc.setActive(req.params.id, false) });
export const activate = async (req, res) => res.json({ success: true, data: await svc.setActive(req.params.id, true) });
