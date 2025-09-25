const express = require('express');
const { query, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { adminAuth } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// Get admin dashboard analytics
router.get('/analytics', adminAuth, async (req, res) => {
  try {
    const [
      totalUsers,
      totalProducts,
      totalOrders,
      totalRevenue,
      pendingOrders,
      lowStockProducts
    ] = await Promise.all([
      prisma.user.count(),
      prisma.product.count(),
      prisma.order.count(),
      prisma.order.aggregate({
        where: { status: { not: 'CANCELLED' } },
        _sum: { totalAmount: true }
      }),
      prisma.order.count({
        where: { status: 'PENDING' }
      }),
      prisma.product.count({
        where: { stock: { lte: 10 } }
      })
    ]);

    // Get top selling products
    const topProducts = await prisma.product.findMany({
      include: {
        orderItems: {
          select: {
            quantity: true
          }
        }
      },
      take: 5
    });

    const topProductsWithSales = topProducts.map(product => ({
      id: product.id,
      name: product.name,
      price: product.price,
      stock: product.stock,
      totalSold: product.orderItems.reduce((sum, item) => sum + item.quantity, 0)
    })).sort((a, b) => b.totalSold - a.totalSold);

    // Recent orders
    const recentOrders = await prisma.order.findMany({
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        orderItems: {
          include: {
            product: {
              select: {
                id: true,
                name: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    // Monthly revenue (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const monthlyRevenue = await prisma.order.groupBy({
      by: ['createdAt'],
      where: {
        createdAt: { gte: sixMonthsAgo },
        status: { not: 'CANCELLED' }
      },
      _sum: { totalAmount: true }
    });

    res.json({
      analytics: {
        totalUsers,
        totalProducts,
        totalOrders,
        totalRevenue: totalRevenue._sum.totalAmount || 0,
        pendingOrders,
        lowStockProducts,
        topProducts: topProductsWithSales,
        recentOrders,
        monthlyRevenue
      }
    });
  } catch (error) {
    console.error('Get admin analytics error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all users
router.get('/users', adminAuth, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('search').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    const where = search ? {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } }
      ]
    } : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          _count: {
            select: {
              orders: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.user.count({ where })
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      users,
      pagination: {
        currentPage: page,
        totalPages,
        totalUsers: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all orders
router.get('/orders', adminAuth, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('status').optional().isIn(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const status = req.query.status;
    const skip = (page - 1) * limit;

    const where = status ? { status } : {};

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true
            }
          },
          orderItems: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true
                }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.order.count({ where })
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      orders,
      pagination: {
        currentPage: page,
        totalPages,
        totalOrders: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update order status
router.put('/orders/:id/status', adminAuth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { status } = req.body;
    
    if (isNaN(orderId)) {
      return res.status(400).json({ message: 'Invalid order ID' });
    }

    if (!['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const existingOrder = await prisma.order.findUnique({
      where: { id: orderId },
      include: { orderItems: true }
    });

    if (!existingOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const order = await prisma.order.update({
      where: { id: orderId },
      data: { status },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        orderItems: {
          include: {
            product: {
              select: {
                id: true,
                name: true
              }
            }
          }
        }
      }
    });

    // If order is cancelled, restore stock
    if (status === 'CANCELLED' && existingOrder.status !== 'CANCELLED') {
      await prisma.$transaction(async (prisma) => {
        for (const item of existingOrder.orderItems) {
          await prisma.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.quantity } }
          });
        }
      });
    }

    res.json({
      message: 'Order status updated successfully',
      order
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete user (Admin only)
router.delete('/users/:id', adminAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    
    if (isNaN(userId)) {
      return res.status(400).json({ message: 'Invalid user ID' });
    }

    // Prevent admin from deleting themselves
    if (userId === req.user.id) {
      return res.status(400).json({ message: 'Cannot delete your own account' });
    }

    const existingUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { orders: true }
    });

    if (!existingUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (existingUser.orders.length > 0) {
      return res.status(400).json({ 
        message: 'Cannot delete user with existing orders' 
      });
    }

    await prisma.user.delete({
      where: { id: userId }
    });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get low stock products
router.get('/products/low-stock', adminAuth, [
  query('threshold').optional().isInt({ min: 0 }).withMessage('Threshold must be a non-negative integer')
], async (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 10;

    const products = await prisma.product.findMany({
      where: {
        stock: { lte: threshold }
      },
      orderBy: { stock: 'asc' }
    });

    res.json({ products });
  } catch (error) {
    console.error('Get low stock products error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
